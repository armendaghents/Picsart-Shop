// ---------------------------------------------------------------------------
// The catalogue
//
// Reading items out of the database and turning rows into the shape the rest
// of the app works with, plus the search that ranks them. Shared by the admin
// inventory API and the storefront: both read the same items, and only differ
// in which fields they are allowed to show.
// ---------------------------------------------------------------------------

import { db } from "../db/connection.js";
import { availabilityStatus, buildFtsQuery, expandTerms, scoreRow, SORTERS } from "./search.js";

export function parseNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function blankToNull(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text ? text : null;
}

export function safeJsonArray(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Admin-defined per-item spec rows (e.g. "Warranty" -> "2 years") that don't
// fit the fixed columns. Stored as a JSON array of {key, value} pairs so
// order is preserved and duplicate-ish keys across items aren't a schema change.
// Two-letter tile shown when an item has no photo. Falls back to a neutral
// placeholder when there is no name to derive it from.
export function defaultIcon(name) {
  return String(name ?? "").trim().slice(0, 2).toUpperCase() || "IT";
}

export function normalizeCustomFields(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => ({ key: String(entry?.key ?? "").trim(), value: String(entry?.value ?? "").trim() }))
    .filter((entry) => entry.key);
}

// Below this row count we score every row in JS (which includes Levenshtein
// typo tolerance) instead of pre-filtering with FTS. FTS prefix matching
// alone can't catch a misspelling like "gamign" -> "gaming", so at
// prototype/demo scale we favor recall and let the scorer sort it out. Past
// this threshold we lean on FTS + LIKE to keep the candidate set bounded for
// large catalogs.
const FULL_SCAN_THRESHOLD = 5000;

// Candidate ids from full-text search (typo-tolerant prefix matching) plus a
// plain substring safety net over identifiers, so SKUs / barcodes / serials
// with punctuation still resolve.
export async function findCandidateIds(query) {
  if (!query || !query.trim()) return null;

  const { count } = await db.prepare("SELECT COUNT(*) AS count FROM inventory_items WHERE deleted_at IS NULL").get();
  if (count <= FULL_SCAN_THRESHOLD) return null;

  const ids = new Set();
  const terms = expandTerms(query);
  const ftsQuery = buildFtsQuery(terms);

  if (ftsQuery) {
    try {
      const rows = await db
        .prepare(`SELECT item_id AS id FROM inventory_fts WHERE document @@ to_tsquery('english', ?)`)
        .all(ftsQuery);
      for (const row of rows) ids.add(row.id);
    } catch {
      // Malformed tsquery syntax (rare, e.g. bare punctuation) — fall through to LIKE-only matching.
    }
  }

  // ILIKE, not LIKE: SQLite's LIKE was case-insensitive for ASCII, Postgres's
  // is not, and this safety net has to keep matching "pc-game" for "PC-GAME".
  const like = `%${query.trim()}%`;
  const likeRows = await db
    .prepare(
      `SELECT id FROM inventory_items
       WHERE deleted_at IS NULL
         AND (sku ILIKE ? OR barcode ILIKE ? OR serial_number ILIKE ? OR name ILIKE ?)`
    )
    .all(like, like, like, like);
  for (const row of likeRows) ids.add(row.id);

  return ids;
}

export function baseSelect() {
  return `
    SELECT
      i.id, i.external_id, i.sku, i.barcode, i.serial_number, i.name, i.brand, i.model,
      i.status, i.condition, i.quantity, i.reserved_quantity, i.reorder_point,
      i.purchase_price, i.selling_price, i.currency, i.description, i.ocr_text,
      i.icon, i.images, i.colors, i.tags, i.custom_fields, i.added_at, i.updated_at,
      c.path AS category_path, w.name AS warehouse_name, l.code AS location_code
    FROM inventory_items i
    LEFT JOIN categories c ON c.id = i.category_id
    LEFT JOIN warehouses w ON w.id = i.warehouse_id
    LEFT JOIN locations l ON l.id = i.location_id
    WHERE i.deleted_at IS NULL
  `;
}

export async function loadFilteredRows({ category = "All", warehouse = "All", status = "All", model = "All", minPrice = 0, maxPrice = Infinity }) {
  const clauses = [];
  const params = [];

  if (category !== "All") {
    clauses.push("c.path ILIKE ?");
    params.push(`${category}%`);
  }
  if (warehouse !== "All") {
    clauses.push("w.name = ?");
    params.push(warehouse);
  }
  if (status !== "All") {
    clauses.push("i.status = ?");
    params.push(status);
  }
  if (model !== "All") {
    clauses.push("i.model = ?");
    params.push(model);
  }
  if (minPrice > 0) {
    clauses.push("i.selling_price >= ?");
    params.push(minPrice);
  }
  if (Number.isFinite(maxPrice)) {
    clauses.push("i.selling_price <= ?");
    params.push(maxPrice);
  }

  // ORDER BY id: the JS sorters are not total orders (equal score, equal stock
  // compares as a tie), so the row order the database returns decides how ties
  // land. SQLite returned rows in rowid order; Postgres has no inherent order,
  // and without this the same query can list items differently each time.
  const sql = baseSelect() + (clauses.length ? ` AND ${clauses.join(" AND ")}` : "") + " ORDER BY i.id";
  return db.prepare(sql).all(...params);
}

export function toDomainItem(row) {
  const tags = safeJsonArray(row.tags);
  const colors = safeJsonArray(row.colors);
  const images = safeJsonArray(row.images);
  const availableQuantity = Math.max(0, row.quantity - row.reserved_quantity);
  return {
    id: row.external_id,
    sku: row.sku,
    barcode: row.barcode,
    serial: row.serial_number,
    name: row.name,
    brand: row.brand,
    model: row.model,
    category: row.category_path,
    warehouse: row.warehouse_name,
    location: row.location_code,
    status: row.status,
    condition: row.condition || "New",
    availability: availabilityStatus(availableQuantity, row.reorder_point, row.status),
    quantity: row.quantity,
    reserved: row.reserved_quantity,
    availableQuantity,
    cost: row.purchase_price,
    price: row.selling_price,
    sellingPrice: row.selling_price,
    currency: row.currency,
    description: row.description,
    ocr: row.ocr_text,
    icon: row.icon || "IT",
    images,
    image: images[0] || null,
    colors: colors.length ? colors : ["#c98a4b", "#8a6a3f"],
    tags,
    tagsText: tags.join(" "),
    customFields: safeJsonArray(row.custom_fields),
    addedAt: row.added_at,
    category_path: row.category_path,
    ocr_text: row.ocr_text,
  };
}

export async function search({ q = "", category = "All", warehouse = "All", status = "All", model = "All", minPrice = 0, maxPrice = Infinity, sort = "relevance", limit = 100 }) {
  const candidateIds = await findCandidateIds(q);
  let rows = await loadFilteredRows({ category, warehouse, status, model, minPrice, maxPrice });
  if (candidateIds) rows = rows.filter((row) => candidateIds.has(row.id));

  let items = rows.map((row) => {
    const item = toDomainItem(row);
    row.tagsText = item.tagsText;
    item.score = scoreRow(row, q);
    return item;
  });

  if (q && q.trim()) items = items.filter((item) => item.score > 0);

  const sorter = SORTERS[sort] || SORTERS.relevance;
  items.sort(sorter);
  return items.slice(0, limit);
}

export async function recordSearchEvent(query, audience, resultCount) {
  try {
    await db.prepare(`INSERT INTO search_events (query, audience, result_count) VALUES (?, ?, ?)`).run(
      query || "",
      audience,
      resultCount
    );
  } catch {
    // Analytics are best-effort; never block a search response on logging failures.
  }
}
