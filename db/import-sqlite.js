// One-time migration: copy an existing SQLite database (the old data/atlas.db)
// into PostgreSQL.
//
//   node db/import-sqlite.js [path/to/atlas.db]
//
// Every target table is emptied first and primary keys are preserved, so the
// result is a faithful copy rather than a merge. The full-text index is rebuilt
// from the imported rows instead of being copied, since FTS5 and Postgres store
// it differently.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

import { openDatabase, describeConnection } from "./init.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SQLITE_PATH = path.join(__dirname, "..", "data", "atlas.db");

// Child tables last on the way in, first on the way out.
const TABLES = ["categories", "warehouses", "locations", "inventory_items", "orders", "search_events"];

async function targetColumns(db, table) {
  const rows = await db
    .prepare(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = ?`
    )
    .all(table);
  return rows.map((row) => row.column_name);
}

function sourceColumns(sqlite, table) {
  return sqlite.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
}

async function copyTable(db, sqlite, table) {
  const exists = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  if (!exists) {
    console.log(`  ${table}: not present in the SQLite file, skipped`);
    return 0;
  }

  // Only columns both sides agree on — an older SQLite file may be missing
  // newer columns, and it may carry retired ones (image_url) we no longer keep.
  const columns = sourceColumns(sqlite, table).filter((column) =>
    targetColumnsCache[table].includes(column)
  );
  const rows = sqlite.prepare(`SELECT ${columns.join(", ")} FROM ${table}`).all();
  if (!rows.length) {
    console.log(`  ${table}: 0 rows`);
    return 0;
  }

  const CHUNK = 200;
  for (let start = 0; start < rows.length; start += CHUNK) {
    const chunk = rows.slice(start, start + CHUNK);
    const values = [];
    const tuples = chunk.map((row) => {
      const placeholders = columns.map((column) => {
        values.push(row[column]);
        return `$${values.length}`;
      });
      return `(${placeholders.join(", ")})`;
    });
    await db.pool.query(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${tuples.join(", ")}`,
      values
    );
  }

  console.log(`  ${table}: ${rows.length} rows`);
  return rows.length;
}

// Identity columns keep their own sequence; after inserting explicit ids it has
// to be moved past the highest one or the next insert collides.
async function resyncSequence(db, table) {
  await db.pool.query(
    `SELECT setval(
       pg_get_serial_sequence($1, 'id'),
       COALESCE((SELECT MAX(id) FROM ${table}), 1),
       (SELECT MAX(id) IS NOT NULL FROM ${table})
     )`,
    [table]
  );
}

async function rebuildSearchIndex(db) {
  await db.pool.query(`
    INSERT INTO inventory_fts (item_id, name, brand, model, sku, barcode, serial_number, tags, ocr_text, description, category_path)
    SELECT
      i.id,
      COALESCE(i.name, ''),
      COALESCE(i.brand, ''),
      COALESCE(i.model, ''),
      COALESCE(i.sku, ''),
      COALESCE(i.barcode, ''),
      COALESCE(i.serial_number, ''),
      COALESCE(
        (SELECT string_agg(value, ' ') FROM json_array_elements_text(
           CASE WHEN i.tags IS NULL OR i.tags = '' THEN '[]'::json ELSE i.tags::json END
         ) AS value),
        ''
      ),
      COALESCE(i.ocr_text, ''),
      COALESCE(i.description, ''),
      COALESCE(c.path, '')
    FROM inventory_items i
    JOIN categories c ON c.id = i.category_id
    WHERE i.deleted_at IS NULL
  `);
  const { rows } = await db.pool.query("SELECT COUNT(*) AS count FROM inventory_fts");
  console.log(`  inventory_fts: ${rows[0].count} rows rebuilt`);
}

const targetColumnsCache = {};

async function main() {
  const sqlitePath = path.resolve(process.argv[2] || DEFAULT_SQLITE_PATH);
  if (!fs.existsSync(sqlitePath)) {
    console.error(`No SQLite database at ${sqlitePath}`);
    process.exit(1);
  }

  const sqlite = new Database(sqlitePath, { readonly: true });
  const db = await openDatabase({ seed: false });

  console.log(`Importing ${sqlitePath}`);
  console.log(`         -> ${describeConnection()}`);
  console.log("Existing rows in the PostgreSQL tables will be replaced.\n");

  try {
    for (const table of TABLES) targetColumnsCache[table] = await targetColumns(db, table);

    await db.pool.query(
      `TRUNCATE ${["inventory_fts", ...TABLES].join(", ")} RESTART IDENTITY CASCADE`
    );

    for (const table of TABLES) await copyTable(db, sqlite, table);
    for (const table of TABLES) await resyncSequence(db, table);
    await rebuildSearchIndex(db);

    console.log("\nImport complete.");
  } catch (error) {
    console.error("\nImport failed:", error.message);
    process.exitCode = 1;
  } finally {
    sqlite.close();
    await db.close();
  }
}

main();
