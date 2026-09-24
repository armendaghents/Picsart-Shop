// ---------------------------------------------------------------------------
// Inventory snapshots
//
// The dashboard tiles are a live reading; this is what turns them into a
// trend. It has to be recorded as it happens — inventory_items keeps only
// added_at, updated_at and deleted_at, and quantity and price are overwritten
// in place, so yesterday's inventory value cannot be reconstructed after the
// fact.
// ---------------------------------------------------------------------------

import { db } from "../db/connection.js";

// GREATEST is Postgres's scalar equivalent of SQLite's two-argument MAX().
export const DASHBOARD_TOTALS_SQL = `SELECT
    COALESCE(SUM(selling_price * quantity), 0) AS inventory_value,
    COALESCE(SUM(GREATEST(quantity - reserved_quantity, 0)), 0) AS stock_count,
    COALESCE(SUM(CASE WHEN GREATEST(quantity - reserved_quantity, 0) <= reorder_point THEN 1 ELSE 0 END), 0) AS low_stock_count,
    COUNT(*) AS item_count
  FROM inventory_items
  WHERE deleted_at IS NULL`;

// The tiles are a live reading; this is what turns them into a trend.
//
// It has to be recorded as it happens — inventory_items keeps only added_at,
// updated_at and deleted_at, and quantity and price are overwritten in place,
// so yesterday's inventory value cannot be reconstructed after the fact.
//
// One row per day, upserted, so a day ends up holding its latest reading no
// matter how often the process restarts.
export async function captureInventorySnapshot() {
  try {
    const totals = await db.prepare(DASHBOARD_TOTALS_SQL).get();
    await db
      .prepare(
        `INSERT INTO inventory_snapshots (captured_on, inventory_value, stock_count, low_stock_count, item_count, captured_at)
         VALUES ((now() AT TIME ZONE 'utc')::date, ?, ?, ?, ?, to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'))
         ON CONFLICT (captured_on) DO UPDATE SET
           inventory_value = EXCLUDED.inventory_value,
           stock_count = EXCLUDED.stock_count,
           low_stock_count = EXCLUDED.low_stock_count,
           item_count = EXCLUDED.item_count,
           captured_at = EXCLUDED.captured_at`
      )
      .run(
        Number(totals.inventory_value) || 0,
        Number(totals.stock_count) || 0,
        Number(totals.low_stock_count) || 0,
        Number(totals.item_count) || 0
      );
    return totals;
  } catch (error) {
    // A dashboard that can't record history is still a working dashboard.
    console.error("[dashboard] snapshot failed:", error.message);
    return null;
  }
}

// Once at boot, then hourly. The hourly pass matters because the row is keyed
// by day: a server started yesterday would otherwise never write today's.
//
// Called by the server rather than run on import: a module that schedules work
// merely because something imported it is impossible to use from a script or a
// test without also starting its timer.
export async function startSnapshotSchedule() {
  await captureInventorySnapshot();
  setInterval(captureInventorySnapshot, 60 * 60 * 1000).unref();
}

// The oldest snapshot at least `days` old, so the comparison is against a real
// recorded day. Falls back to the oldest one on record while the history is
// still shorter than the window — better an honest "vs 3 days ago" than
// nothing at all for the first week.
export async function baselineSnapshot(days) {
  const within = await db
    .prepare(
      `SELECT captured_on::text AS captured_on, inventory_value, stock_count, low_stock_count, item_count
       FROM inventory_snapshots
       WHERE captured_on <= ((now() AT TIME ZONE 'utc')::date - ?::int)
       ORDER BY captured_on DESC
       LIMIT 1`
    )
    .get(days);
  if (within) return within;
  return db
    .prepare(
      `SELECT captured_on::text AS captured_on, inventory_value, stock_count, low_stock_count, item_count
       FROM inventory_snapshots
       WHERE captured_on < (now() AT TIME ZONE 'utc')::date
       ORDER BY captured_on ASC
       LIMIT 1`
    )
    .get();
}

export const TREND_WINDOW_DAYS = 7;
