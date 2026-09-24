// ---------------------------------------------------------------------------
// Buying: writing an order, and the basket that leads to one
//
// Both ways to buy — the product page's Order button and a basket checkout —
// come through writeOrder(), so an order placed either way has the same shape,
// the same number and the same status.
//
// NOTE: checkout still takes no payment. It records the order and moves stock
// immediately, which is what the payment work has to invert.
// ---------------------------------------------------------------------------

import { asyncRouter } from "../lib/async-routes.js";
import { requireUser } from "../lib/customer-session.js";
import { requireCsrf } from "../lib/csrf.js";
import { db, NOW_SQL } from "../db/connection.js";
import { orderConfirmationEmail, sendMail } from "../lib/mailer.js";
import {
  DELIVERY_DEFAULT_METHOD,
  formatMoney,
  fromMinor,
  newOrderNumber,
  normaliseDelivery,
  ORDER_STATUS_PENDING,
  toMinor,
} from "../lib/orders.js";
import { baseSelect, parseNumber, safeJsonArray, toDomainItem } from "../lib/catalog.js";
import { availabilityStatus } from "../lib/search.js";
import { toShopItem } from "./shop.js";

const router = asyncRouter();

// ---------------------------------------------------------------------------
// Writing an order
//
// Both ways to buy — the product page's Order button and a basket checkout —
// come through here, so an order placed either way has the same shape, the
// same number and the same status. The caller has already locked and adjusted
// the stock rows; this only records what was bought.
// ---------------------------------------------------------------------------

// Sent by the client to make a retry safe: same key, same order, no matter how
// many times the request arrives. A double-clicked Order button, a request
// retried over a flaky connection, or (once payments land) a provider
// replaying its webhook would otherwise each place a second order.
function readIdempotencyKey(request) {
  const raw = request.get("Idempotency-Key") || request.body?.idempotencyKey || "";
  const key = String(raw).trim();
  // Long enough for a UUID and then some; anything past that is not a key.
  return key && key.length <= 200 ? key : null;
}

// The statement layer flattens array arguments into separate parameters (see
// params.flat() in db/client.js), so one `= ANY(?)` placeholder cannot receive
// a list — the ids have to be expanded into a placeholder each.
export function placeholders(count) {
  return Array.from({ length: count }, () => "?").join(", ");
}

// The delivery block as the API speaks it. Kept in one place so the customer's
// order history, the admin's day view and a replayed checkout all describe a
// destination the same way.
// Rejected before anything is locked or decremented: an order that cannot be
// delivered should never have taken stock off the shelf in the first place.
function rejectBadDelivery(response, errors) {
  return response.status(400).json({
    error: "delivery_invalid",
    message: "We need a delivery address we can actually ship to.",
    fields: errors,
  });
}

export function toDelivery(row) {
  return {
    method: row.delivery_method || DELIVERY_DEFAULT_METHOD,
    name: row.ship_name,
    phone: row.ship_phone,
    country: row.ship_country,
    city: row.ship_city,
    line1: row.ship_line1,
    line2: row.ship_line2,
    postalCode: row.ship_postal_code,
    notes: row.ship_notes,
  };
}

function toOrderSummary(row) {
  return {
    id: row.id,
    orderNumber: row.order_number,
    status: row.status,
    totalMinor: Number(row.total_minor),
    total: fromMinor(row.total_minor),
    currency: row.currency,
    placedAt: row.placed_at,
    delivery: toDelivery(row),
  };
}

// Scoped to the buyer as well as the key: one customer's key can never return
// another's order, however it was generated.
async function findOrderByIdempotencyKey(tx, userId, key) {
  if (!key) return null;
  const row = await tx
    .prepare(
      `SELECT id, order_number, status, total_minor, currency, placed_at,
              delivery_method, ship_name, ship_phone, ship_country, ship_city,
              ship_line1, ship_line2, ship_postal_code, ship_notes
       FROM orders WHERE idempotency_key = ? AND user_id = ?`
    )
    .get(key, userId);
  return row ? toOrderSummary(row) : null;
}

// The receipt.
//
// Sent after the transaction commits, never inside it: a mail server has no
// business being able to roll back an order. And fire-and-forget, following
// the rest of the app's notifications — the order is already placed, so a slow
// or broken SMTP host must not turn a successful checkout into an error the
// customer sees.
function sendOrderConfirmation({ to, order, lines }) {
  if (!to) return;
  sendMail({
    to,
    ...orderConfirmationEmail({
      orderNumber: order.orderNumber,
      placedAt: order.placedAt,
      total: formatMoney(order.totalMinor, order.currency),
      delivery: order.delivery,
      lines: lines.map((line) => ({
        quantity: line.quantity,
        name: line.name || line.sku || "Item",
        lineTotal: formatMoney(line.unitPriceMinor * line.quantity, order.currency),
      })),
    }),
  }).catch(() => {});
}

async function writeOrder(tx, { userId, idempotencyKey = null, currency = "USD", lines, delivery }) {
  // Totalled from the lines here rather than trusted from the caller: the
  // stored total is what the customer agreed to pay, and it must be derivable
  // from the very rows saved beside it.
  const totalMinor = lines.reduce((sum, line) => sum + line.unitPriceMinor * line.quantity, 0);

  const order = await tx
    .prepare(
      `INSERT INTO orders (
         order_number, user_id, status, total_minor, currency, idempotency_key,
         delivery_method, ship_name, ship_phone, ship_country, ship_city,
         ship_line1, ship_line2, ship_postal_code, ship_notes
       )
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       RETURNING id, order_number, status, total_minor, currency, placed_at,
                 delivery_method, ship_name, ship_phone, ship_country, ship_city,
                 ship_line1, ship_line2, ship_postal_code, ship_notes`
    )
    .get(
      newOrderNumber(),
      userId,
      ORDER_STATUS_PENDING,
      totalMinor,
      currency,
      idempotencyKey,
      delivery.method,
      delivery.name,
      delivery.phone,
      delivery.country,
      delivery.city,
      delivery.line1,
      delivery.line2,
      delivery.postalCode,
      delivery.notes
    );

  for (const line of lines) {
    await tx
      .prepare(
        `INSERT INTO order_items (order_id, inventory_item_id, sku, name, brand, model, category, quantity, unit_price_minor)
         VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run(
        order.id,
        line.inventoryItemId,
        line.sku ?? null,
        line.name ?? null,
        line.brand ?? null,
        line.model ?? null,
        line.category ?? null,
        line.quantity,
        line.unitPriceMinor
      );
  }

  return toOrderSummary(order);
}

router.post("/api/shop/orders", requireUser, requireCsrf, async (request, response) => {
  const { itemId } = request.body || {};
  if (!itemId) {
    return response.status(400).json({ error: "validation_failed", message: "Missing itemId." });
  }
  const idempotencyKey = readIdempotencyKey(request);
  const { value: delivery, errors } = normaliseDelivery(request.body?.delivery);
  if (errors.length) return rejectBadDelivery(response, errors);

  try {
    // Stock check, decrement, and order row all happen in one transaction, so
    // two shoppers racing for the last unit can't both take it and a failure
    // halfway through can't leave an order without the matching stock change.
    const result = await db.transaction(async (tx) => {
      // Checked inside the transaction, before any stock moves: a retry must
      // not take a second unit off the shelf on its way to being recognised.
      const replay = await findOrderByIdempotencyKey(tx, request.user.id, idempotencyKey);
      if (replay) return { status: 200, body: { ok: true, order: replay, replayed: true } };

      const row = await tx
        .prepare(
          `SELECT i.id, i.sku, i.name, i.brand, i.model, i.quantity, i.reserved_quantity, i.selling_price, c.path AS category_path
           FROM inventory_items i
           LEFT JOIN categories c ON c.id = i.category_id
           WHERE i.external_id = ? AND i.deleted_at IS NULL
           FOR UPDATE OF i`
        )
        .get(itemId);
      if (!row) return { status: 404, body: { error: "not_found", message: "Product not found." } };
      if (row.quantity - row.reserved_quantity <= 0) {
        return { status: 400, body: { error: "out_of_stock", message: "This item is currently out of stock." } };
      }

      await tx.prepare(`UPDATE inventory_items SET quantity = quantity - 1, updated_at = ${NOW_SQL} WHERE id = ?`).run(row.id);
      const order = await writeOrder(tx, {
        userId: request.user.id,
        idempotencyKey,
        currency: row.currency || "USD",
        delivery,
        lines: [
          {
            inventoryItemId: row.id,
            sku: row.sku,
            name: row.name,
            brand: row.brand,
            model: row.model,
            category: row.category_path,
            quantity: 1,
            unitPriceMinor: toMinor(row.selling_price),
          },
        ],
      });

      const updatedRow = await tx.prepare(`${baseSelect()} AND i.external_id = ?`).get(itemId);
      updatedRow.tagsText = safeJsonArray(updatedRow.tags).join(" ");
      const updatedItem = toDomainItem(updatedRow);
      updatedItem.score = 50;

      return {
        status: 201,
        body: { ok: true, item: toShopItem(updatedItem) },
        receipt: {
          order,
          lines: [{ quantity: 1, name: row.name, sku: row.sku, unitPriceMinor: toMinor(row.selling_price) }],
        },
      };
    });

    if (result.receipt) {
      sendOrderConfirmation({ to: request.user.email, ...result.receipt });
    }
    response.status(result.status).json(result.body);
  } catch (error) {
    console.error("[shop] order failed:", error);
    response.status(500).json({ error: "order_failed", message: error.message });
  }
});

router.get("/api/shop/facets", async (_request, response) => {
  try {
    const categories = (await db
      .prepare(
        `SELECT DISTINCT c.path COLLATE "C" AS path FROM categories c
         JOIN inventory_items i ON i.category_id = c.id
         WHERE i.deleted_at IS NULL
         ORDER BY path`
      )
      .all())
      .map((r) => r.path);
    // Aliases are quoted: Postgres folds unquoted identifiers to lower case,
    // which would turn these into minprice / maxprice in the JSON response.
    const priceBounds = await db
      .prepare(
        `SELECT COALESCE(MIN(selling_price), 0) AS "minPrice", COALESCE(MAX(selling_price), 0) AS "maxPrice"
         FROM inventory_items
         WHERE deleted_at IS NULL`
      )
      .get();
    response.json({ categories, minPrice: priceBounds.minPrice, maxPrice: priceBounds.maxPrice });
  } catch (error) {
    console.error("[shop] facets failed:", error);
    response.status(500).json({ error: "shop_facets_failed", message: error.message });
  }
});

// ---------------------------------------------------------------------------
// Basket
//
// The basket is server-side and tied to the account, so it follows the customer
// between devices and nothing about it — least of all the price — is decided by
// the browser. Every read recomputes totals from current catalogue prices.
// ---------------------------------------------------------------------------
const MAX_LINE_QUANTITY = 99;
const SELLABLE_STATUSES = new Set(["Available", "Low Stock", "Reserved", "Out of Stock"]);

// Money is summed in integer cents. Floating point would drift: 19.99 * 3 is
// 59.97000000000001, and that eventually shows up as a wrong total.
const CART_LINES_SQL = `
  SELECT ci.id, ci.quantity, ci.inventory_item_id,
         i.external_id, i.name, i.sku, i.brand, i.model, i.selling_price, i.currency, i.status,
         i.quantity AS stock_quantity, i.reserved_quantity, i.reorder_point,
         i.icon, i.images, i.colors, c.path AS category_path
  FROM cart_items ci
  JOIN inventory_items i ON i.id = ci.inventory_item_id
  LEFT JOIN categories c ON c.id = i.category_id
  WHERE ci.user_id = ? AND i.deleted_at IS NULL
  ORDER BY ci.added_at, ci.id
`;

async function loadCart(userId, scope = db) {
  const rows = await scope.prepare(CART_LINES_SQL).all(userId);

  // Totals are grouped by the item's own currency rather than blindly added
  // together, so a mixed-currency basket can still be displayed correctly.
  const totalsByCurrency = new Map();
  let itemCount = 0;

  const lines = rows.map((row) => {
    const availableQuantity = Math.max(0, row.stock_quantity - row.reserved_quantity);
    const unitCents = toMinor(row.selling_price);
    const lineCents = unitCents * row.quantity;
    const currency = row.currency || "USD";

    totalsByCurrency.set(currency, (totalsByCurrency.get(currency) || 0) + lineCents);
    itemCount += row.quantity;

    const images = safeJsonArray(row.images);
    const colors = safeJsonArray(row.colors);
    return {
      itemId: row.external_id,
      name: row.name,
      sku: row.sku,
      brand: row.brand,
      model: row.model,
      category: row.category_path,
      icon: row.icon || "IT",
      image: images[0] || null,
      colors: colors.length ? colors : ["#c98a4b", "#8a6a3f"],
      currency,
      unitPrice: fromMinor(unitCents),
      quantity: row.quantity,
      lineTotal: fromMinor(lineCents),
      availableQuantity,
      availability: availabilityStatus(availableQuantity, row.reorder_point, row.status),
      // Flagged rather than silently dropped, so the basket can explain why a
      // line can't be checked out instead of quietly losing it.
      purchasable: availableQuantity >= row.quantity && SELLABLE_STATUSES.has(row.status),
    };
  });

  return {
    lines,
    itemCount,
    totals: [...totalsByCurrency].map(([currency, cents]) => ({ currency, subtotal: fromMinor(cents) })),
  };
}

async function findSellableItem(externalId, scope = db) {
  return scope
    .prepare(
      `SELECT id, external_id, name, sku, brand, model, status, quantity, reserved_quantity, selling_price
       FROM inventory_items
       WHERE external_id = ? AND deleted_at IS NULL`
    )
    .get(externalId);
}

router.get("/api/shop/cart", requireUser, async (request, response) => {
  try {
    response.json(await loadCart(request.user.id));
  } catch (error) {
    console.error("[cart] load failed:", error);
    response.status(500).json({ error: "cart_failed", message: error.message });
  }
});

// Clicking Buy on something already in the basket adds to that line instead of
// creating a second one — that's the UNIQUE (user_id, inventory_item_id) below.
router.post("/api/shop/cart", requireUser, requireCsrf, async (request, response) => {
  const { itemId } = request.body || {};
  const requested = Math.trunc(parseNumber(request.body?.quantity, 1));
  if (!itemId) {
    return response.status(400).json({ error: "validation_failed", message: "Missing itemId." });
  }
  if (requested < 1 || requested > MAX_LINE_QUANTITY) {
    return response.status(400).json({ error: "validation_failed", message: `Quantity must be between 1 and ${MAX_LINE_QUANTITY}.` });
  }

  try {
    const item = await findSellableItem(itemId);
    if (!item || !SELLABLE_STATUSES.has(item.status)) {
      return response.status(404).json({ error: "not_found", message: "Product not found." });
    }

    const available = Math.max(0, item.quantity - item.reserved_quantity);
    if (available <= 0) {
      return response.status(409).json({ error: "out_of_stock", message: "This item is currently out of stock." });
    }

    const existing = await db
      .prepare("SELECT quantity FROM cart_items WHERE user_id = ? AND inventory_item_id = ?")
      .get(request.user.id, item.id);
    const current = existing?.quantity || 0;
    const target = Math.min(current + requested, available, MAX_LINE_QUANTITY);

    if (target === current) {
      const cart = await loadCart(request.user.id);
      return response.status(409).json({
        error: "stock_limit",
        message: `Only ${available} left in stock, and they're already in your basket.`,
        available,
        cart,
      });
    }

    await db
      .prepare(
        `INSERT INTO cart_items (user_id, inventory_item_id, quantity) VALUES (?, ?, ?)
         ON CONFLICT (user_id, inventory_item_id)
         DO UPDATE SET quantity = EXCLUDED.quantity, updated_at = ${NOW_SQL}`
      )
      .run(request.user.id, item.id, target);

    response.status(201).json(await loadCart(request.user.id));
  } catch (error) {
    console.error("[cart] add failed:", error);
    response.status(500).json({ error: "cart_add_failed", message: error.message });
  }
});

// Absolute quantity, not a delta — this is what the +/- controls send.
router.patch("/api/shop/cart/:itemId", requireUser, requireCsrf, async (request, response) => {
  const quantity = Math.trunc(parseNumber(request.body?.quantity, NaN));
  if (!Number.isFinite(quantity) || quantity < 0 || quantity > MAX_LINE_QUANTITY) {
    return response.status(400).json({ error: "validation_failed", message: `Quantity must be between 0 and ${MAX_LINE_QUANTITY}.` });
  }

  try {
    const item = await findSellableItem(request.params.itemId);
    if (!item) {
      return response.status(404).json({ error: "not_found", message: "Product not found." });
    }

    if (quantity === 0) {
      await db.prepare("DELETE FROM cart_items WHERE user_id = ? AND inventory_item_id = ?").run(request.user.id, item.id);
      return response.json(await loadCart(request.user.id));
    }

    const available = Math.max(0, item.quantity - item.reserved_quantity);
    if (quantity > available) {
      return response.status(409).json({
        error: "stock_limit",
        message: `Only ${available} left in stock.`,
        available,
        cart: await loadCart(request.user.id),
      });
    }

    const result = await db
      .prepare(`UPDATE cart_items SET quantity = ?, updated_at = ${NOW_SQL} WHERE user_id = ? AND inventory_item_id = ?`)
      .run(quantity, request.user.id, item.id);
    if (!result.changes) {
      return response.status(404).json({ error: "not_found", message: "That item isn't in your basket." });
    }

    response.json(await loadCart(request.user.id));
  } catch (error) {
    console.error("[cart] update failed:", error);
    response.status(500).json({ error: "cart_update_failed", message: error.message });
  }
});

router.delete("/api/shop/cart/:itemId", requireUser, requireCsrf, async (request, response) => {
  try {
    const item = await findSellableItem(request.params.itemId);
    if (item) {
      await db.prepare("DELETE FROM cart_items WHERE user_id = ? AND inventory_item_id = ?").run(request.user.id, item.id);
    }
    response.json(await loadCart(request.user.id));
  } catch (error) {
    console.error("[cart] remove failed:", error);
    response.status(500).json({ error: "cart_remove_failed", message: error.message });
  }
});

router.delete("/api/shop/cart", requireUser, requireCsrf, async (request, response) => {
  try {
    await db.prepare("DELETE FROM cart_items WHERE user_id = ?").run(request.user.id);
    response.json(await loadCart(request.user.id));
  } catch (error) {
    console.error("[cart] clear failed:", error);
    response.status(500).json({ error: "cart_clear_failed", message: error.message });
  }
});

// A customer's own order history. Scoped to their user id, so one account can
// never read another's — the orders table also holds rows from before accounts
// existed, and those belong to nobody.
router.get("/api/shop/orders", requireUser, async (request, response) => {
  try {
    // One query per side rather than a join: a join would repeat every order's
    // number, status and total once per line, and the lines then have to be
    // de-duplicated back out again. Two small reads are plainer and cheaper.
    const orders = await db
      .prepare(
        `SELECT id, order_number, status, total_minor, currency, placed_at,
                delivery_method, ship_name, ship_phone, ship_country, ship_city,
                ship_line1, ship_line2, ship_postal_code, ship_notes
         FROM orders
         WHERE user_id = ?
         ORDER BY placed_at DESC, id DESC
         LIMIT 200`
      )
      .all(request.user.id);

    if (!orders.length) return response.json({ orders: [] });

    const orderIds = orders.map((order) => order.id);
    const lines = await db
      .prepare(
        `SELECT id, order_id, sku, name, brand, model, category, quantity, unit_price_minor
         FROM order_items
         WHERE order_id IN (${placeholders(orderIds.length)})
         ORDER BY id`
      )
      .all(orderIds);

    const linesByOrder = new Map();
    for (const line of lines) {
      if (!linesByOrder.has(line.order_id)) linesByOrder.set(line.order_id, []);
      linesByOrder.get(line.order_id).push({
        id: line.id,
        sku: line.sku,
        name: line.name,
        brand: line.brand,
        model: line.model,
        category: line.category,
        quantity: line.quantity,
        // `price` is the unit price, the name the storefront already renders.
        price: fromMinor(line.unit_price_minor),
        lineTotal: fromMinor(Number(line.unit_price_minor) * line.quantity),
      });
    }

    response.json({
      orders: orders.map((order) => {
        const orderLines = linesByOrder.get(order.id) || [];
        return {
          orderNumber: order.order_number,
          status: order.status,
          // The total as it was agreed, read back from the order rather than
          // recomputed from today's prices.
          total: fromMinor(order.total_minor),
          currency: order.currency,
          placedAt: order.placed_at,
          delivery: toDelivery(order),
          itemCount: orderLines.reduce((sum, line) => sum + line.quantity, 0),
          lines: orderLines,
        };
      }),
    });
  } catch (error) {
    console.error("[shop] order history failed:", error);
    response.status(500).json({ error: "orders_failed", message: error.message });
  }
});

// What the customer last asked us to deliver to, so a returning shopper is not
// made to retype an address the shop already has. Read from their own most
// recent order rather than a saved profile field: it is the address that
// demonstrably worked, and it needs no second place to keep it up to date.
router.get("/api/shop/delivery/latest", requireUser, async (request, response) => {
  try {
    const row = await db
      .prepare(
        `SELECT delivery_method, ship_name, ship_phone, ship_country, ship_city,
                ship_line1, ship_line2, ship_postal_code, ship_notes
         FROM orders
         WHERE user_id = ? AND ship_name IS NOT NULL
         ORDER BY placed_at DESC, id DESC
         LIMIT 1`
      )
      .get(request.user.id);

    // Notes are per-order instructions ("leave with the neighbour"), not a
    // property of the address, so they are deliberately not carried forward.
    response.json({ delivery: row ? { ...toDelivery(row), notes: null } : null });
  } catch (error) {
    console.error("[shop] delivery prefill failed:", error);
    response.status(500).json({ error: "delivery_failed", message: error.message });
  }
});

// Checkout: the basket becomes orders and stock moves. All of it in one
// transaction with the stock rows locked, so two people checking out the last
// unit can't both get it, and a failure part-way can't leave an order without
// the matching stock change.
router.post("/api/shop/cart/checkout", requireUser, requireCsrf, async (request, response) => {
  const idempotencyKey = readIdempotencyKey(request);

  // Validated up front, outside the transaction: it needs no database at all,
  // and failing here keeps a bad address from ever locking a stock row.
  const { value: delivery, errors } = normaliseDelivery(request.body?.delivery);
  if (errors.length) return rejectBadDelivery(response, errors);

  try {
    const result = await db.transaction(async (tx) => {
      // Before the basket is read, let alone emptied: a retried checkout has
      // to return the order it already placed, not find an empty basket and
      // report failure for an order that actually succeeded.
      const replay = await findOrderByIdempotencyKey(tx, request.user.id, idempotencyKey);
      if (replay) {
        return {
          status: 200,
          body: {
            ok: true,
            replayed: true,
            orderNumber: replay.orderNumber,
            status: replay.status,
            total: replay.total,
            currency: replay.currency,
          },
        };
      }

      const rows = await tx
        .prepare(
          `SELECT ci.quantity, i.id, i.external_id, i.name, i.sku, i.brand, i.model, i.status,
                  i.quantity AS stock_quantity, i.reserved_quantity, i.selling_price, i.currency,
                  c.path AS category_path
           FROM cart_items ci
           JOIN inventory_items i ON i.id = ci.inventory_item_id
           LEFT JOIN categories c ON c.id = i.category_id
           WHERE ci.user_id = ? AND i.deleted_at IS NULL
           ORDER BY ci.added_at, ci.id
           FOR UPDATE OF i`
        )
        .all(request.user.id);

      if (!rows.length) {
        return { status: 400, body: { error: "empty_basket", message: "Your basket is empty." } };
      }

      // Re-check every line against stock as it is right now, inside the lock.
      const unavailable = rows
        .filter((row) => {
          const available = Math.max(0, row.stock_quantity - row.reserved_quantity);
          return !SELLABLE_STATUSES.has(row.status) || available < row.quantity;
        })
        .map((row) => ({
          itemId: row.external_id,
          name: row.name,
          wanted: row.quantity,
          available: Math.max(0, row.stock_quantity - row.reserved_quantity),
        }));

      if (unavailable.length) {
        return {
          status: 409,
          body: {
            error: "insufficient_stock",
            message: "Some items are no longer available in the quantity you asked for.",
            lines: unavailable,
          },
        };
      }

      for (const row of rows) {
        await tx
          .prepare(`UPDATE inventory_items SET quantity = quantity - ?, updated_at = ${NOW_SQL} WHERE id = ?`)
          .run(row.quantity, row.id);
      }

      const order = await writeOrder(tx, {
        userId: request.user.id,
        idempotencyKey,
        currency: rows[0].currency || "USD",
        delivery,
        lines: rows.map((row) => ({
          inventoryItemId: row.id,
          sku: row.sku,
          name: row.name,
          brand: row.brand,
          model: row.model,
          category: row.category_path,
          quantity: row.quantity,
          unitPriceMinor: toMinor(row.selling_price),
        })),
      });

      await tx.prepare("DELETE FROM cart_items WHERE user_id = ?").run(request.user.id);

      return {
        status: 201,
        receipt: {
          order,
          lines: rows.map((row) => ({
            quantity: row.quantity,
            name: row.name,
            sku: row.sku,
            unitPriceMinor: toMinor(row.selling_price),
          })),
        },
        body: {
          ok: true,
          orderNumber: order.orderNumber,
          status: order.status,
          delivery: order.delivery,
          // The number of distinct product lines. Named orderCount before the
          // split, when each line genuinely was its own order row; kept so the
          // storefront keeps working, and now accompanied by lineCount, which
          // says what it actually means.
          orderCount: rows.length,
          lineCount: rows.length,
          itemCount: rows.reduce((sum, row) => sum + row.quantity, 0),
          total: fromMinor(order.totalMinor),
          currency: order.currency,
        },
      };
    });

    if (result.status === 201) {
      console.log(`[cart] checkout by user ${request.user.id}: ${result.body.orderCount} lines`);
      sendOrderConfirmation({ to: request.user.email, ...result.receipt });
    }
    response.status(result.status).json(result.body);
  } catch (error) {
    console.error("[cart] checkout failed:", error);
    response.status(500).json({ error: "checkout_failed", message: error.message });
  }
});

export default router;
