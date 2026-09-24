// ---------------------------------------------------------------------------
// Admin analytics — order calendar
//
// "How did last month go", as opposed to routes/admin-orders.js, which answers
// "what has to go out today".
// ---------------------------------------------------------------------------

import { asyncRouter } from "../lib/async-routes.js";
import { requireAdmin } from "../lib/admin-session.js";
import { db } from "../db/connection.js";
import { fromMinor } from "../lib/orders.js";
import { parseNumber } from "../lib/catalog.js";
import { placeholders, toDelivery } from "./cart.js";

const router = asyncRouter();

// ---------------------------------------------------------------------------
// Admin analytics — order calendar
// ---------------------------------------------------------------------------
const MONTH_PATTERN = /^\d{4}-\d{2}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// placed_at is stored in UTC. The admin's browser reports its own offset
// (minutes to ADD to UTC to get local time, i.e. -Date#getTimezoneOffset())
// so "which calendar day is this order on" matches the admin's local day
// instead of the UTC day, which otherwise disagree near midnight.
function tzOffsetMinutes(request) {
  const raw = Math.trunc(parseNumber(request.query.tzOffset, 0));
  return Math.max(-840, Math.min(840, raw)); // real-world offsets span -12:00..+14:00
}

// placed_at is text, so it is cast to a timestamp before the offset is applied.
const LOCAL_PLACED_AT = "placed_at::timestamp + make_interval(mins => ?)";

router.get("/api/analytics/orders/summary", requireAdmin, async (request, response) => {
  const { month } = request.query;
  if (!MONTH_PATTERN.test(month || "")) {
    return response.status(400).json({ error: "validation_failed", message: "month must be YYYY-MM." });
  }

  try {
    const offset = tzOffsetMinutes(request);
    const rows = await db
      .prepare(
        // COUNT(*) over `orders` is now a count of orders. Before the split it
        // ran over the flat table and counted product lines, so a customer who
        // bought three things in one basket showed up as three orders.
        `SELECT to_char(${LOCAL_PLACED_AT}, 'YYYY-MM-DD') AS day, COUNT(*) AS count
         FROM orders
         WHERE to_char(${LOCAL_PLACED_AT}, 'YYYY-MM') = ?
         GROUP BY day`
      )
      .all(offset, offset, month);
    const days = Object.fromEntries(rows.map((row) => [row.day, row.count]));
    response.json({ days });
  } catch (error) {
    console.error("[analytics] order summary failed:", error);
    response.status(500).json({ error: "analytics_failed", message: error.message });
  }
});

router.get("/api/analytics/orders/day", requireAdmin, async (request, response) => {
  const { date } = request.query;
  if (!DATE_PATTERN.test(date || "")) {
    return response.status(400).json({ error: "validation_failed", message: "date must be YYYY-MM-DD." });
  }

  try {
    const offset = tzOffsetMinutes(request);
    const orders = await db
      .prepare(
        `SELECT o.id, o.order_number, o.status, o.total_minor, o.currency, o.placed_at,
                o.delivery_method, o.ship_name, o.ship_phone, o.ship_country, o.ship_city,
                o.ship_line1, o.ship_line2, o.ship_postal_code, o.ship_notes,
                u.email AS buyer_email
         FROM orders o
         LEFT JOIN users u ON u.id = o.user_id
         WHERE to_char(${LOCAL_PLACED_AT}, 'YYYY-MM-DD') = ?
         ORDER BY o.placed_at DESC, o.id DESC`
      )
      .all(offset, date);

    if (!orders.length) return response.json({ orders: [] });

    const orderIds = orders.map((order) => order.id);
    const lines = await db
      .prepare(
        `SELECT id, order_id, sku, name, brand, model, category, quantity, unit_price_minor
         FROM order_items WHERE order_id IN (${placeholders(orderIds.length)}) ORDER BY id`
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
        price: fromMinor(line.unit_price_minor),
      });
    }

    response.json({
      orders: orders.map((order) => ({
        id: order.id,
        orderNumber: order.order_number,
        status: order.status,
        total: fromMinor(order.total_minor),
        currency: order.currency,
        placedAt: order.placed_at,
        buyerEmail: order.buyer_email,
        // Staff cannot pack a parcel without this.
        delivery: toDelivery(order),
        lines: linesByOrder.get(order.id) || [],
      })),
    });
  } catch (error) {
    console.error("[analytics] order day lookup failed:", error);
    response.status(500).json({ error: "analytics_failed", message: error.message });
  }
});

export default router;
