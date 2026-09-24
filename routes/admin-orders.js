// ---------------------------------------------------------------------------
// Admin — running the orders
//
// The fulfilment console: what has to be packed today, where it is going, and
// the only write staff can make to an order — a status change, policed by the
// transition table in lib/orders.js.
// ---------------------------------------------------------------------------

import { asyncRouter } from "../lib/async-routes.js";
import { requireAdmin } from "../lib/admin-session.js";
import { requireCsrf } from "../lib/csrf.js";
import { db, NOW_SQL } from "../db/connection.js";
import {
  canTransition,
  fromMinor,
  isOrderStatus,
  nextStatuses,
  ORDER_STATUSES,
  releasesStock,
} from "../lib/orders.js";
import { parseNumber } from "../lib/catalog.js";
import { orderStatusEmail, sendMail } from "../lib/mailer.js";
import { placeholders, toDelivery } from "./cart.js";

const router = asyncRouter();

// ---------------------------------------------------------------------------
// Admin — running the orders
//
// The calendar below answers "how did last month go"; this answers "what do we
// have to pack today, and where is it going". Every read is scoped to admins,
// and the only write is a status change, which the transition table in
// lib/orders.js polices.
// ---------------------------------------------------------------------------
const ORDERS_PAGE_SIZE = 20;

// Attaches each order's lines in one extra query rather than one per order.
async function withOrderLines(orders) {
  if (!orders.length) return [];
  const ids = orders.map((order) => order.id);
  const lines = await db
    .prepare(
      `SELECT id, order_id, inventory_item_id, sku, name, brand, model, category, quantity, unit_price_minor
       FROM order_items WHERE order_id IN (${placeholders(ids.length)}) ORDER BY id`
    )
    .all(ids);

  const byOrder = new Map();
  for (const line of lines) {
    if (!byOrder.has(line.order_id)) byOrder.set(line.order_id, []);
    byOrder.get(line.order_id).push({
      id: line.id,
      itemId: line.inventory_item_id,
      sku: line.sku,
      name: line.name,
      brand: line.brand,
      model: line.model,
      category: line.category,
      quantity: line.quantity,
      price: fromMinor(line.unit_price_minor),
      lineTotal: fromMinor(Number(line.unit_price_minor) * line.quantity),
    });
  }

  return orders.map((order) => ({
    id: order.id,
    orderNumber: order.order_number,
    status: order.status,
    // What the console is allowed to offer, decided by the same table the
    // write endpoint enforces — so a button can never ask for a move the
    // server will refuse.
    nextStatuses: nextStatuses(order.status),
    total: fromMinor(order.total_minor),
    currency: order.currency,
    placedAt: order.placed_at,
    updatedAt: order.updated_at,
    buyerEmail: order.buyer_email,
    paymentRef: order.payment_ref,
    delivery: toDelivery(order),
    lines: byOrder.get(order.id) || [],
  }));
}

const ADMIN_ORDER_COLUMNS = `o.id, o.order_number, o.status, o.total_minor, o.currency,
  o.placed_at, o.updated_at, o.payment_ref,
  o.delivery_method, o.ship_name, o.ship_phone, o.ship_country, o.ship_city,
  o.ship_line1, o.ship_line2, o.ship_postal_code, o.ship_notes,
  u.email AS buyer_email`;

router.get("/api/admin/orders", requireAdmin, async (request, response) => {
  const status = String(request.query.status || "all").toLowerCase();
  if (status !== "all" && !isOrderStatus(status)) {
    return response.status(400).json({ error: "validation_failed", message: "Unknown status filter." });
  }

  const search = String(request.query.q || "").trim();
  const page = Math.max(1, Math.trunc(parseNumber(request.query.page, 1)));

  try {
    const where = ["1=1"];
    const params = [];
    if (status !== "all") {
      where.push("o.status = ?");
      params.push(status);
    }
    if (search) {
      // The three things staff actually have in hand when they go looking: the
      // number from the customer's email, the address they wrote to, or the
      // account they ordered from.
      where.push("(o.order_number ILIKE ? OR u.email ILIKE ? OR o.ship_name ILIKE ?)");
      const pattern = `%${search}%`;
      params.push(pattern, pattern, pattern);
    }
    const clause = where.join(" AND ");

    const { count } = await db
      .prepare(`SELECT COUNT(*) AS count FROM orders o LEFT JOIN users u ON u.id = o.user_id WHERE ${clause}`)
      .get(params);
    const total = Number(count);
    const totalPages = Math.max(1, Math.ceil(total / ORDERS_PAGE_SIZE));
    const safePage = Math.min(page, totalPages);

    const rows = await db
      .prepare(
        `SELECT ${ADMIN_ORDER_COLUMNS}
         FROM orders o LEFT JOIN users u ON u.id = o.user_id
         WHERE ${clause}
         ORDER BY o.placed_at DESC, o.id DESC
         LIMIT ? OFFSET ?`
      )
      .all(params, ORDERS_PAGE_SIZE, (safePage - 1) * ORDERS_PAGE_SIZE);

    response.json({
      orders: await withOrderLines(rows),
      total,
      page: safePage,
      pageSize: ORDERS_PAGE_SIZE,
      totalPages,
      // So the console can render one tab per status with its count, rather
      // than a filter that gives no clue what is behind it.
      counts: Object.fromEntries(
        (
          await db
            .prepare("SELECT status, COUNT(*) AS count FROM orders GROUP BY status")
            .all()
        ).map((row) => [row.status, Number(row.count)])
      ),
    });
  } catch (error) {
    console.error("[admin] order list failed:", error);
    response.status(500).json({ error: "orders_failed", message: error.message });
  }
});

router.get("/api/admin/orders/:id", requireAdmin, async (request, response) => {
  try {
    const row = await db
      .prepare(
        `SELECT ${ADMIN_ORDER_COLUMNS}
         FROM orders o LEFT JOIN users u ON u.id = o.user_id
         WHERE o.id = ?`
      )
      .get(Math.trunc(parseNumber(request.params.id, 0)));
    if (!row) return response.status(404).json({ error: "not_found", message: "No such order." });
    const [order] = await withOrderLines([row]);
    response.json({ order });
  } catch (error) {
    console.error("[admin] order lookup failed:", error);
    response.status(500).json({ error: "orders_failed", message: error.message });
  }
});

router.patch("/api/admin/orders/:id/status", requireAdmin, requireCsrf, async (request, response) => {
  const target = String(request.body?.status || "").toLowerCase();
  if (!isOrderStatus(target)) {
    return response.status(400).json({
      error: "validation_failed",
      message: `status must be one of: ${ORDER_STATUSES.join(", ")}.`,
    });
  }
  const id = Math.trunc(parseNumber(request.params.id, 0));

  try {
    const result = await db.transaction(async (tx) => {
      // Locked for the same reason checkout locks stock: two admins clicking
      // at once must not both see 'paid' and both move it on.
      const order = await tx
        .prepare(
          `SELECT o.id, o.status, o.order_number, u.email AS buyer_email
           FROM orders o LEFT JOIN users u ON u.id = o.user_id
           WHERE o.id = ? FOR UPDATE OF o`
        )
        .get(id);
      if (!order) return { status: 404, body: { error: "not_found", message: "No such order." } };

      if (order.status === target) {
        return { status: 200, body: { ok: true, status: target, unchanged: true } };
      }
      if (!canTransition(order.status, target)) {
        return {
          status: 409,
          body: {
            error: "bad_transition",
            message: `An order that is ${order.status} cannot become ${target}.`,
            allowed: nextStatuses(order.status),
          },
        };
      }

      // Cancelling puts the goods back: checkout took them off the shelf when
      // the order was placed, and nobody has received them.
      if (releasesStock(order.status, target)) {
        const lines = await tx.prepare("SELECT inventory_item_id, quantity FROM order_items WHERE order_id = ?").all(id);
        for (const line of lines) {
          await tx
            .prepare(`UPDATE inventory_items SET quantity = quantity + ?, updated_at = ${NOW_SQL} WHERE id = ?`)
            .run(line.quantity, line.inventory_item_id);
        }
      }

      await tx.prepare(`UPDATE orders SET status = ?, updated_at = ${NOW_SQL} WHERE id = ?`).run(target, id);
      return {
        status: 200,
        body: { ok: true, status: target, from: order.status },
        notify: { to: order.buyer_email, orderNumber: order.order_number },
      };
    });

    if (result.status === 200 && !result.body.unchanged) {
      // Named, because "who marked this shipped" is the first question asked
      // when a parcel goes missing.
      console.log(`[orders] #${id} ${result.body.from} -> ${target} by admin ${request.admin?.username || "?"}`);

      // After the commit, and fire-and-forget: the status has already changed,
      // so a mail failure must not report the change as failed. Only some
      // transitions have a message — orderStatusEmail returns null for the
      // rest, and an order placed before accounts existed has nobody to tell.
      const message = orderStatusEmail({ orderNumber: result.notify.orderNumber, status: target });
      if (message && result.notify.to) {
        sendMail({ to: result.notify.to, ...message }).catch(() => {});
      }
    }
    response.status(result.status).json(result.body);
  } catch (error) {
    console.error("[admin] order status change failed:", error);
    response.status(500).json({ error: "status_failed", message: error.message });
  }
});

export default router;
