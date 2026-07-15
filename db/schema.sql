-- Atlas Search — SQLite schema

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS warehouses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  code TEXT NOT NULL,
  UNIQUE (warehouse_id, code)
);

CREATE TABLE IF NOT EXISTS inventory_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id TEXT NOT NULL UNIQUE,
  sku TEXT NOT NULL UNIQUE,
  barcode TEXT,
  serial_number TEXT,
  name TEXT NOT NULL,
  brand TEXT,
  model TEXT,
  category_id INTEGER NOT NULL REFERENCES categories(id),
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  location_id INTEGER NOT NULL REFERENCES locations(id),
  status TEXT NOT NULL DEFAULT 'Available',
  condition TEXT NOT NULL DEFAULT 'New',  -- 'New' or 'Used'
  quantity INTEGER NOT NULL DEFAULT 0,
  reserved_quantity INTEGER NOT NULL DEFAULT 0,
  reorder_point INTEGER NOT NULL DEFAULT 5,
  purchase_price REAL NOT NULL DEFAULT 0,
  selling_price REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  description TEXT,
  ocr_text TEXT,
  icon TEXT,
  images TEXT,      -- JSON array of photo URLs, e.g. ["/uploads/a.jpg","/uploads/b.jpg"] — first is the main photo (falls back to icon+colors tile when empty)
  colors TEXT,      -- JSON array, e.g. ["#107c72","#5f6fb5"]
  tags TEXT,        -- JSON array, e.g. ["gaming pc","desktop"]
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_items_category ON inventory_items(category_id);
CREATE INDEX IF NOT EXISTS idx_items_warehouse ON inventory_items(warehouse_id);
CREATE INDEX IF NOT EXISTS idx_items_status ON inventory_items(status);
CREATE INDEX IF NOT EXISTS idx_items_deleted ON inventory_items(deleted_at);

-- Full text search index (name, brand, model, sku, barcode, serial, tags, ocr, description, category path).
-- Deliberately NOT a contentless table: contentless FTS5 tables reject plain
-- DELETE/UPDATE (they require the 'delete' command with the original column
-- values supplied), which breaks admin edit/delete. We always re-read real
-- data from inventory_items anyway, so the small extra storage here is a
-- reasonable trade for simple re-indexing.
CREATE VIRTUAL TABLE IF NOT EXISTS inventory_fts USING fts5(
  name, brand, model, sku, barcode, serial_number, tags, ocr_text, description, category_path,
  tokenize='porter unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS search_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  query TEXT,
  audience TEXT NOT NULL DEFAULT 'admin', -- admin | shop
  result_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
