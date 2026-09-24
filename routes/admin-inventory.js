// ---------------------------------------------------------------------------
// Admin inventory API — full internal detail (cost, reserved qty, notes, etc.)
//
// Everything the console needs to run the catalogue: search across it, create
// and edit items, upload photos, and read the dashboard. Every route is behind
// requireAdmin; nothing here is safe to show a customer.
// ---------------------------------------------------------------------------

import crypto from "node:crypto";
import fs from "node:fs";
import multer from "multer";
import path from "node:path";

import { asyncRouter } from "../lib/async-routes.js";
import { requireAdmin } from "../lib/admin-session.js";
import { requireCsrf } from "../lib/csrf.js";

import { UPLOADS_DIR } from "../lib/config.js";
import { db, NOW_SQL } from "../db/connection.js";
import { isUniqueViolation } from "../db/client.js";
import { describeUpload, normalizeUpload } from "../lib/images.js";
import {
  baseSelect,
  blankToNull,
  defaultIcon,
  normalizeCustomFields,
  parseNumber,
  recordSearchEvent,
  safeJsonArray,
  search,
  toDomainItem,
} from "../lib/catalog.js";
import { baselineSnapshot, DASHBOARD_TOTALS_SQL, TREND_WINDOW_DAYS } from "../lib/snapshots.js";

const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (_request, file, callback) => {
      const ext = path.extname(file.originalname).toLowerCase() || ".jpg";
      callback(null, `${crypto.randomBytes(12).toString("hex")}${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_request, file, callback) => {
    callback(null, ALLOWED_IMAGE_TYPES.has(file.mimetype));
  },
});

const router = asyncRouter();

// ---------------------------------------------------------------------------
// Admin inventory API — full internal detail (cost, reserved qty, notes, etc.)
// ---------------------------------------------------------------------------
router.get("/api/inventory", requireAdmin, async (request, response) => {
  const { q = "", category = "All", warehouse = "All", status = "All", model = "All", sort = "relevance" } = request.query;
  const maxPrice = request.query.maxPrice === "Infinity" ? Infinity : parseNumber(request.query.maxPrice, 10000);
  const page = Math.max(1, Math.trunc(parseNumber(request.query.page, 1)));
  const pageSize = Math.min(Math.max(1, Math.trunc(parseNumber(request.query.pageSize, 50))), 200);

  try {
    const items = await search({ q, category, warehouse, status, model, maxPrice, sort, limit: 100000 });

    const total = items.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const currentPage = Math.min(page, totalPages);
    const start = (currentPage - 1) * pageSize;
    const pageItems = items.slice(start, start + pageSize);

    await recordSearchEvent(q, "admin", total);
    response.json({ items: pageItems, total, page: currentPage, pageSize, totalPages });
  } catch (error) {
    console.error("[inventory] search failed:", error);
    response.status(500).json({ error: "inventory_search_failed", message: error.message });
  }
});

router.post("/api/admin/upload", requireAdmin, (request, response) => {
  upload.single("image")(request, response, async (error) => {
    if (error) {
      console.error("[upload] single upload failed:", error);
      return response.status(400).json({ error: "upload_failed", message: error.message });
    }
    if (!request.file) {
      return response.status(400).json({ error: "upload_failed", message: "No image file received (jpg/png/webp/gif, up to 5MB)." });
    }

    const result = await normalizeUpload(request.file.path);
    console.log(describeUpload(result));
    response.json({
      url: `/uploads/${path.basename(result.path)}`,
      // Reported back so the console can tell the admin their photo is too
      // small while they still have the better original to hand.
      undersized: Boolean(result.undersized),
      width: result.width,
      height: result.height,
    });
  });
});

router.post("/api/admin/upload-multiple", requireAdmin, (request, response) => {
  upload.array("images", 10)(request, response, async (error) => {
    if (error) {
      console.error("[upload] multi upload failed:", error);
      return response.status(400).json({ error: "upload_failed", message: error.message });
    }
    if (!request.files || !request.files.length) {
      return response.status(400).json({ error: "upload_failed", message: "No image files received (jpg/png/webp/gif, up to 5MB each)." });
    }

    const results = [];
    for (const file of request.files) {
      const result = await normalizeUpload(file.path);
      console.log(describeUpload(result));
      results.push(result);
    }
    response.json({
      urls: results.map((result) => `/uploads/${path.basename(result.path)}`),
      undersized: results.filter((result) => result.undersized).length,
    });
  });
});

// Best-effort cleanup for a photo uploaded to an in-progress "Add Item" draft
// that gets removed before the item is ever saved (so it's definitely orphaned).
router.delete("/api/admin/upload", requireAdmin, (request, response) => {
  const { url } = request.body || {};
  if (typeof url !== "string" || !/^\/uploads\/[a-zA-Z0-9._-]+$/.test(url)) {
    return response.status(400).json({ error: "validation_failed", message: "Invalid upload url." });
  }

  const filePath = path.join(UPLOADS_DIR, path.basename(url));
  fs.unlink(filePath, (error) => {
    if (error && error.code !== "ENOENT") {
      console.error("[upload] delete failed:", error);
      return response.status(500).json({ error: "delete_failed", message: error.message });
    }
    response.json({ ok: true });
  });
});

router.post("/api/inventory", requireAdmin, async (request, response) => {
  const body = request.body || {};

  try {
    const category = blankToNull(body.category);
    const categoryId = category ? await upsertLookupByPath(category) : null;
    const warehouseId = body.warehouse ? await upsertLookup("warehouses", body.warehouse) : null;
    const locationId = warehouseId && body.location ? await upsertLocation(warehouseId, body.location) : null;

    const quantity = Math.max(0, parseNumber(body.quantity, 0));
    const reserved = Math.max(0, parseNumber(body.reserved, 0));
    const reorderPoint = Math.max(0, parseNumber(body.reorderPoint, 5));

    const created = await db
      .prepare(
        `INSERT INTO inventory_items (
          external_id, sku, barcode, serial_number, name, brand, model,
          category_id, warehouse_id, location_id, status, condition, quantity, reserved_quantity, reorder_point,
          purchase_price, selling_price, currency, description, ocr_text, icon, images, colors, tags, custom_fields
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        RETURNING id`
      )
      .get(
        body.externalId || `ITM-${Date.now()}`,
        blankToNull(body.sku),
        blankToNull(body.barcode),
        blankToNull(body.serial),
        blankToNull(body.name),
        blankToNull(body.brand),
        blankToNull(body.model),
        categoryId,
        warehouseId,
        locationId,
        body.status || "Available",
        body.condition || "New",
        quantity,
        reserved,
        reorderPoint,
        Math.max(0, parseNumber(body.cost, 0)),
        Math.max(0, parseNumber(body.price, 0)),
        body.currency || "USD",
        body.description || "",
        body.ocr || "",
        body.icon || defaultIcon(body.name),
        JSON.stringify(body.images || []),
        JSON.stringify(body.colors || ["#c98a4b", "#8a6a3f"]),
        JSON.stringify(body.tags || []),
        JSON.stringify(normalizeCustomFields(body.customFields))
      );

    const id = created.id;
    const row = await db.prepare(`SELECT tags, ocr_text, description, name, brand, model, sku, barcode, serial_number FROM inventory_items WHERE id = ?`).get(id);
    await reindexItem(id, { ...row, category_path: category });

    console.log(`[inventory] created item ${body.sku} (id ${id})`);
    response.status(201).json({ ok: true, id });
  } catch (error) {
    const message = isUniqueViolation(error) ? "An item with that SKU already exists." : error.message;
    console.error(`[inventory] create failed for sku ${body.sku}:`, error);
    response.status(400).json({ error: "create_failed", message });
  }
});

router.get("/api/inventory/:id", requireAdmin, async (request, response) => {
  try {
    const row = await db.prepare(`${baseSelect()} AND i.external_id = ?`).get(request.params.id);
    if (!row) {
      return response.status(404).json({ error: "not_found", message: "Item not found." });
    }
    row.tagsText = safeJsonArray(row.tags).join(" ");
    const item = toDomainItem(row);
    item.score = 50;
    response.json(item);
  } catch (error) {
    console.error(`[inventory] lookup failed for ${request.params.id}:`, error);
    response.status(500).json({ error: "inventory_lookup_failed", message: error.message });
  }
});

router.put("/api/inventory/:id", requireAdmin, async (request, response) => {
  const body = request.body || {};

  let existing;
  try {
    existing = await db.prepare(`SELECT id FROM inventory_items WHERE external_id = ? AND deleted_at IS NULL`).get(request.params.id);
  } catch (error) {
    console.error(`[inventory] lookup failed for ${request.params.id}:`, error);
    return response.status(500).json({ error: "update_failed", message: error.message });
  }
  if (!existing) {
    return response.status(404).json({ error: "not_found", message: "Item not found." });
  }

  try {
    const category = blankToNull(body.category);
    const categoryId = category ? await upsertLookupByPath(category) : null;
    const warehouseId = body.warehouse ? await upsertLookup("warehouses", body.warehouse) : null;
    const locationId = warehouseId && body.location ? await upsertLocation(warehouseId, body.location) : null;

    const quantity = Math.max(0, parseNumber(body.quantity, 0));
    const reserved = Math.max(0, parseNumber(body.reserved, 0));
    const reorderPoint = Math.max(0, parseNumber(body.reorderPoint, 5));

    await db.prepare(
      `UPDATE inventory_items SET
        sku = ?, barcode = ?, serial_number = ?, name = ?, brand = ?, model = ?,
        category_id = ?, warehouse_id = ?, location_id = ?, status = ?, condition = ?,
        quantity = ?, reserved_quantity = ?, reorder_point = ?,
        purchase_price = ?, selling_price = ?, currency = ?, description = ?, ocr_text = ?,
        icon = ?, images = ?, colors = ?, tags = ?, custom_fields = ?, updated_at = ${NOW_SQL}
      WHERE id = ?`
    ).run(
      blankToNull(body.sku),
      blankToNull(body.barcode),
      blankToNull(body.serial),
      blankToNull(body.name),
      blankToNull(body.brand),
      blankToNull(body.model),
      categoryId,
      warehouseId,
      locationId,
      body.status || "Available",
      body.condition || "New",
      quantity,
      reserved,
      reorderPoint,
      Math.max(0, parseNumber(body.cost, 0)),
      Math.max(0, parseNumber(body.price, 0)),
      body.currency || "USD",
      body.description || "",
      body.ocr || "",
      body.icon || defaultIcon(body.name),
      JSON.stringify(body.images || []),
      JSON.stringify(body.colors || ["#c98a4b", "#8a6a3f"]),
      JSON.stringify(body.tags || []),
      JSON.stringify(normalizeCustomFields(body.customFields)),
      existing.id
    );

    await reindexItem(existing.id, {
      name: body.name,
      brand: body.brand,
      model: body.model,
      sku: body.sku,
      barcode: body.barcode,
      serial_number: body.serial,
      tags: JSON.stringify(body.tags || []),
      ocr_text: body.ocr,
      description: body.description,
      category_path: category,
    });

    console.log(`[inventory] updated item ${body.sku} (id ${existing.id})`);
    response.json({ ok: true, id: existing.id });
  } catch (error) {
    const message = isUniqueViolation(error) ? "An item with that SKU already exists." : error.message;
    console.error(`[inventory] update failed for id ${existing.id}:`, error);
    response.status(400).json({ error: "update_failed", message });
  }
});

router.delete("/api/inventory/:id", requireAdmin, async (request, response) => {
  try {
    const existing = await db.prepare(`SELECT id FROM inventory_items WHERE external_id = ? AND deleted_at IS NULL`).get(request.params.id);
    if (!existing) {
      return response.status(404).json({ error: "not_found", message: "Item not found." });
    }

    await db.prepare(`UPDATE inventory_items SET deleted_at = ${NOW_SQL} WHERE id = ?`).run(existing.id);
    await db.prepare(`DELETE FROM inventory_fts WHERE item_id = ?`).run(existing.id);

    console.log(`[inventory] deleted item id ${existing.id}`);
    response.json({ ok: true });
  } catch (error) {
    console.error(`[inventory] delete failed for ${request.params.id}:`, error);
    response.status(500).json({ error: "delete_failed", message: error.message });
  }
});

async function upsertLookup(table, name) {
  const existing = await db.prepare(`SELECT id FROM ${table} WHERE name = ?`).get(name);
  if (existing) return existing.id;
  const created = await db.prepare(`INSERT INTO ${table} (name) VALUES (?) RETURNING id`).get(name);
  return created.id;
}

async function upsertLookupByPath(pathValue) {
  const existing = await db.prepare(`SELECT id FROM categories WHERE path = ?`).get(pathValue);
  if (existing) return existing.id;
  const name = pathValue.split(">").map((part) => part.trim()).at(-1);
  const created = await db.prepare(`INSERT INTO categories (name, path) VALUES (?, ?) RETURNING id`).get(name, pathValue);
  return created.id;
}

async function upsertLocation(warehouseId, code) {
  const existing = await db.prepare(`SELECT id FROM locations WHERE warehouse_id = ? AND code = ?`).get(warehouseId, code);
  if (existing) return existing.id;
  const created = await db.prepare(`INSERT INTO locations (warehouse_id, code) VALUES (?, ?) RETURNING id`).get(warehouseId, code);
  return created.id;
}

async function reindexItem(id, row) {
  await db.prepare(`DELETE FROM inventory_fts WHERE item_id = ?`).run(id);
  const tags = safeJsonArray(row.tags).join(" ");
  await db.prepare(
    `INSERT INTO inventory_fts (item_id, name, brand, model, sku, barcode, serial_number, tags, ocr_text, description, category_path)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(id, row.name || "", row.brand || "", row.model || "", row.sku || "", row.barcode || "", row.serial_number || "", tags, row.ocr_text || "", row.description || "", row.category_path || "");
}

router.get("/api/facets", requireAdmin, async (request, response) => {
  const { category = "All" } = request.query;
  try {
    // Scoped to categories/warehouses actually used by a live item, so a
    // category left behind by a deleted item doesn't linger in the dropdown.
    const categories = (await db
      .prepare(
        `SELECT DISTINCT c.path COLLATE "C" AS path FROM categories c
         JOIN inventory_items i ON i.category_id = c.id
         WHERE i.deleted_at IS NULL
         ORDER BY path`
      )
      .all())
      .map((r) => r.path);
    const warehouses = (await db
      .prepare(
        `SELECT DISTINCT w.name COLLATE "C" AS name FROM warehouses w
         JOIN inventory_items i ON i.warehouse_id = w.id
         WHERE i.deleted_at IS NULL
         ORDER BY name`
      )
      .all())
      .map((r) => r.name);
    const statuses = (await db
      .prepare(`SELECT DISTINCT status COLLATE "C" AS status FROM inventory_items WHERE deleted_at IS NULL ORDER BY status`)
      .all())
      .map((r) => r.status);

    // Scoped to the selected category so the model list stays relevant
    // (e.g. picking "Camera" only offers camera models, not every model in the catalog).
    const modelClauses = ["i.deleted_at IS NULL", "i.model IS NOT NULL", "i.model != ''"];
    const modelParams = [];
    if (category !== "All") {
      modelClauses.push("c.path ILIKE ?");
      modelParams.push(`${category}%`);
    }
    const models = (await db
      .prepare(
        `SELECT DISTINCT i.model COLLATE "C" AS model FROM inventory_items i
         LEFT JOIN categories c ON c.id = i.category_id
         WHERE ${modelClauses.join(" AND ")}
         ORDER BY model`
      )
      .all(...modelParams))
      .map((r) => r.model);

    response.json({ categories, warehouses, statuses, models });
  } catch (error) {
    console.error("[facets] failed:", error);
    response.status(500).json({ error: "facets_failed", message: error.message });
  }
});

router.get("/api/dashboard", requireAdmin, async (_request, response) => {
  try {
    const row = await db.prepare(DASHBOARD_TOTALS_SQL).get();
    const searches = await db.prepare(`SELECT COUNT(*) AS count FROM search_events`).get();

    // No earlier day on record yet — the console shows the figure with no
    // movement rather than inventing a 0% change.
    const baseline = await baselineSnapshot(TREND_WINDOW_DAYS);
    const trend = baseline
      ? {
          since: baseline.captured_on,
          inventory_value: Number(row.inventory_value) - Number(baseline.inventory_value),
          stock_count: Number(row.stock_count) - Number(baseline.stock_count),
          low_stock_count: Number(row.low_stock_count) - Number(baseline.low_stock_count),
          item_count: Number(row.item_count) - Number(baseline.item_count),
          // Percentages only make sense against a non-zero starting point.
          inventory_value_pct:
            Number(baseline.inventory_value) > 0
              ? ((Number(row.inventory_value) - Number(baseline.inventory_value)) / Number(baseline.inventory_value)) * 100
              : null,
        }
      : null;

    response.json({ ...row, total_searches: searches.count, trend });
  } catch (error) {
    console.error("[dashboard] failed:", error);
    response.status(500).json({ error: "dashboard_failed", message: error.message });
  }
});

// ---------------------------------------------------------------------------
// Display exchange rates
// ---------------------------------------------------------------------------

// USD is the base the shop prices in, so a rate for it other than 1 would make
// every converted figure wrong in a way nothing else would catch.
const RATE_BASE = "USD";

router.get("/api/admin/rates", requireAdmin, async (_request, response) => {
  const rows = await db
    .prepare("SELECT code, rate, updated_by, updated_at FROM exchange_rates ORDER BY code")
    .all();
  response.json({ base: RATE_BASE, rates: rows.map((row) => ({ ...row, rate: Number(row.rate) })) });
});

router.put("/api/admin/rates/:code", requireAdmin, requireCsrf, async (request, response) => {
  const code = String(request.params.code || "").trim().toUpperCase();
  const rate = Number(request.body?.rate);

  if (!/^[A-Z]{3}$/.test(code)) {
    return response.status(400).json({ error: "validation_failed", message: "Currency must be a three-letter code." });
  }
  if (!Number.isFinite(rate) || rate <= 0) {
    return response.status(400).json({ error: "validation_failed", message: "Rate must be a number greater than zero." });
  }
  if (code === RATE_BASE && rate !== 1) {
    return response.status(400).json({
      error: "validation_failed",
      message: `${RATE_BASE} is the currency the shop prices in — its rate is always 1.`,
    });
  }

  const who = request.admin?.username || "admin";
  await db
    .prepare(
      `INSERT INTO exchange_rates (code, rate, updated_by, updated_at)
       VALUES (?,?,?,${NOW_SQL})
       ON CONFLICT (code) DO UPDATE SET rate = EXCLUDED.rate, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`
    )
    .run(code, rate, who);

  console.log(`[rates] ${code} set to ${rate} by admin ${who}`);
  response.json({ ok: true, code, rate });
});

router.delete("/api/admin/rates/:code", requireAdmin, requireCsrf, async (request, response) => {
  const code = String(request.params.code || "").trim().toUpperCase();
  if (code === RATE_BASE) {
    return response.status(400).json({ error: "validation_failed", message: `${RATE_BASE} cannot be removed.` });
  }
  const result = await db.prepare("DELETE FROM exchange_rates WHERE code = ?").run(code);
  if (!result.changes) return response.status(404).json({ error: "not_found", message: "No such currency." });
  console.log(`[rates] ${code} removed by admin ${request.admin?.username || "admin"}`);
  response.json({ ok: true });
});

export default router;
