// ---------------------------------------------------------------------------
// The one open database, shared by every route module
//
// Opened here rather than in server.js so a route file can import `db` without
// being handed it, and so the process still dies on an unreachable database
// instead of serving 500s. The top-level await is deliberate: nothing that
// imports this should run before the connection is proven.
// ---------------------------------------------------------------------------

import { IS_PRODUCTION } from "../lib/config.js";
import { openDatabase } from "./init.js";

let database;
try {
  // The seed catalogue is invented sample stock — ApexForge workstations,
  // Northstar laptops — and it is written only when the items table is empty.
  // That is exactly the state a real shop starts in, so without this flag the
  // first production boot would put products nobody sells in front of
  // customers, priced and orderable. Development keeps them: an empty shop is
  // hard to work on.
  database = await openDatabase({ seed: !IS_PRODUCTION });
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

export const db = database;

// PostgreSQL equivalent of SQLite's datetime('now') — a UTC timestamp in the
// same 'YYYY-MM-DD HH:MM:SS' text format every stored timestamp uses.
export const NOW_SQL = "to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')";
