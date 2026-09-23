// Dashboard trend indicators.
//
// The tiles read live totals; the trend compares them against inventory_snapshots,
// which the server writes one row per day. This suite backdates a row so the
// comparison has something to point at, then puts the table back as it found it.

import pg from "pg";

import { makeJar, makeRecorder } from "./helpers.mjs";

export default async function run(client, { adminPassword, databaseUrl }) {
  const { call } = client;
  const t = makeRecorder("dashboard trends");

  const admin = makeJar();
  await call(admin, "GET", "/api/auth/csrf");
  await call(admin, "POST", "/api/admin/login", { password: adminPassword });

  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();

  try {
    t.section("recording");
    const { rows: today } = await db.query(
      "SELECT captured_on::text AS captured_on FROM inventory_snapshots WHERE captured_on = (now() AT TIME ZONE 'utc')::date"
    );
    t.check("the server records a snapshot for today at boot", today.length === 1, JSON.stringify(today));

    t.section("no history yet");
    await db.query("DELETE FROM inventory_snapshots WHERE captured_on < (now() AT TIME ZONE 'utc')::date");
    let r = await call(admin, "GET", "/api/dashboard");
    t.check("totals still load", r.status === 200 && typeof r.data.inventory_value === "number", JSON.stringify(r.data).slice(0, 120));
    // With nothing earlier on record the API says so, rather than reporting a
    // 0% change that would read as "flat" instead of "unknown".
    t.check("no earlier day means no trend at all", r.data.trend === null, JSON.stringify(r.data.trend));

    t.section("with a week of history");
    const current = r.data;
    await db.query(
      `INSERT INTO inventory_snapshots (captured_on, inventory_value, stock_count, low_stock_count, item_count)
       VALUES (((now() AT TIME ZONE 'utc')::date - 7), $1, $2, $3, $4)`,
      [
        Number(current.inventory_value) / 2,
        Number(current.stock_count) + 20,
        Number(current.low_stock_count) - 3,
        Number(current.item_count),
      ]
    );

    r = await call(admin, "GET", "/api/dashboard");
    const trend = r.data.trend;
    t.check("a trend appears once there is a day to compare with", Boolean(trend), JSON.stringify(trend));
    t.check("it names the day it is comparing against", typeof trend?.since === "string", `${trend?.since}`);
    t.check("inventory value doubling reads as +100%", Math.abs(trend.inventory_value_pct - 100) < 0.001, `${trend.inventory_value_pct}`);
    t.check("twenty fewer units in stock", trend.stock_count === -20, `${trend.stock_count}`);
    t.check("three more items low on stock", trend.low_stock_count === 3, `${trend.low_stock_count}`);
    t.check("an unchanged item count reports zero, not nothing", trend.item_count === 0, `${trend.item_count}`);

    t.section("a zero baseline can't be a percentage");
    await db.query("DELETE FROM inventory_snapshots WHERE captured_on < (now() AT TIME ZONE 'utc')::date");
    await db.query(
      `INSERT INTO inventory_snapshots (captured_on, inventory_value, stock_count, low_stock_count, item_count)
       VALUES (((now() AT TIME ZONE 'utc')::date - 7), 0, 0, 0, 0)`
    );
    r = await call(admin, "GET", "/api/dashboard");
    t.check("growth from zero reports an absolute change, not Infinity",
      r.data.trend.inventory_value_pct === null && r.data.trend.inventory_value > 0,
      JSON.stringify(r.data.trend));
  } finally {
    await db.query("DELETE FROM inventory_snapshots WHERE captured_on < (now() AT TIME ZONE 'utc')::date");
    await db.end();
  }

  return t.result();
}
