import "dotenv/config";
import cors from "cors";
import crypto from "node:crypto";
import express from "express";
import fs from "node:fs";
import helmet from "helmet";
import multer from "multer";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { openDatabase } from "./db/init.js"
import {
  buildFtsQuery,
  expandTerms,
  scoreRow,
  SORTERS,
  availabilityStatus,
} from "./lib/search.js";

const app = express();
const port = Number(process.env.PORT || 3000);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = path.join(__dirname, "public", "uploads");
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const db = openDatabase();

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

// ---------------------------------------------------------------------------
// Admin authentication — a single shared password (set ADMIN_PASSWORD in .env)
// gates the admin console and every admin API route. Sessions are an
// in-memory token set, which is enough for a single small team; if you need
// multiple staff accounts or roles later, swap this for real user rows +
// hashed passwords.
// ---------------------------------------------------------------------------
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "changeme";
const SESSION_COOKIE = "atlas_session";
const SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000; // 8 hours
const sessions = new Map(); // token -> expiresAt

if (!process.env.ADMIN_PASSWORD) {
  console.warn(
    "WARNING: ADMIN_PASSWORD is not set in .env — using the default password 'changeme'. Set a real password before deploying."
  );
}

function parseCookies(header) {
  const cookies = {};
  (header || "").split(";").forEach((pair) => {
    const separatorIndex = pair.indexOf("=");
    if (separatorIndex === -1) return;
    const key = pair.slice(0, separatorIndex).trim();
    const value = pair.slice(separatorIndex + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  });
  return cookies;
}

function isAuthed(request) {
  const cookies = parseCookies(request.headers.cookie);
  const token = cookies[SESSION_COOKIE];
  if (!token || !sessions.has(token)) return false;
  const expiresAt = sessions.get(token);
  if (Date.now() > expiresAt) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function requireAdmin(request, response, next) {
  if (isAuthed(request)) return next();
  response.status(401).json({ error: "unauthorized", message: "Admin login required." });
}

function setSessionCookie(response, token) {
  response.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1000)}`
  );
}

function clearSessionCookie(response) {
  response.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
}

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------------------
// Request logging — logs every request's method, path, status code, and
// duration once it finishes. Kept dependency-free (no morgan) so it's easy
// to swap out later.
// ---------------------------------------------------------------------------
app.use((request, response, next) => {
  const start = Date.now();
  response.on("finish", () => {
    const ms = Date.now() - start;
    console.log(`${request.method} ${request.originalUrl} ${response.statusCode} ${ms}ms`);
  });
  next();
});

app.post("/api/admin/login", (request, response) => {
  const { password } = request.body || {};
  if (typeof password === "string" && password.length && password === ADMIN_PASSWORD) {
    const token = crypto.randomBytes(24).toString("hex");
    sessions.set(token, Date.now() + SESSION_MAX_AGE_MS);
    setSessionCookie(response, token);
    console.log(`[auth] admin login succeeded from ${request.ip}`);
    return response.json({ ok: true });
  }
  console.warn(`[auth] admin login failed from ${request.ip}`);
  response.status(401).json({ ok: false, message: "Incorrect password." });
});

app.post("/api/admin/logout", (request, response) => {
  const cookies = parseCookies(request.headers.cookie);
  if (cookies[SESSION_COOKIE]) sessions.delete(cookies[SESSION_COOKIE]);
  clearSessionCookie(response);
  console.log(`[auth] admin logout from ${request.ip}`);
  response.json({ ok: true });
});

app.get("/api/admin/session", (request, response) => {
  response.json({ authenticated: isAuthed(request) });
});

// Gate the admin page itself: an unauthenticated visitor never sees the
// dashboard shell, only a login prompt. /admin is the canonical URL (serves
// content directly, no redirect); /admin.html keeps working the same way
// for anyone with an old link.
function serveAdmin(request, response) {
  if (isAuthed(request)) {
    return response.sendFile(path.join(__dirname, "public", "admin.html"));
  }
  response.send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>PicsArt Shop — Admin Login</title>
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <div style="min-height:100vh; display:grid; place-items:center; background:var(--page-gradient);">
      <form id="loginForm" style="width:100%; max-width:340px; padding:26px; border:1px solid var(--line); border-radius:12px; background:var(--panel); box-shadow:var(--shadow);">
        <h2 style="margin:0 0 4px;">Admin login</h2>
        <p style="margin:0 0 16px; color:var(--muted); font-size:0.88rem;">Staff access only.</p>
        <input id="password" type="password" placeholder="Password" autofocus
          style="width:100%; padding:10px 12px; margin-bottom:12px; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--text); font-size:0.95rem;" />
        <p id="loginError" style="display:none; margin:0 0 12px; color:var(--danger); font-size:0.85rem;"></p>
        <button type="submit" class="command-button" style="width:100%; justify-content:center;">Log in</button>
      </form>
    </div>
    <script>
      document.getElementById("loginForm").addEventListener("submit", async (event) => {
        event.preventDefault();
        const password = document.getElementById("password").value;
        const errorBox = document.getElementById("loginError");
        try {
          const response = await fetch("/api/admin/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password }),
          });
          if (!response.ok) throw new Error("bad password");
          window.location.reload();
        } catch {
          errorBox.textContent = "Incorrect password.";
          errorBox.style.display = "block";
        }
      });
    </script>
  </body>
</html>`);
}

app.get("/admin", serveAdmin);
app.get("/admin.html", serveAdmin);

app.use(express.static(path.join(__dirname, "public")));

function parseNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeJsonArray(value) {
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
function normalizeCustomFields(value) {
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
function findCandidateIds(query) {
  if (!query || !query.trim()) return null;

  const { count } = db.prepare("SELECT COUNT(*) AS count FROM inventory_items WHERE deleted_at IS NULL").get();
  if (count <= FULL_SCAN_THRESHOLD) return null;

  const ids = new Set();
  const terms = expandTerms(query);
  const ftsQuery = buildFtsQuery(terms);

  if (ftsQuery) {
    try {
      const rows = db.prepare(`SELECT rowid AS id FROM inventory_fts WHERE inventory_fts MATCH ?`).all(ftsQuery);
      for (const row of rows) ids.add(row.id);
    } catch {
      // Malformed FTS syntax (rare, e.g. bare punctuation) — fall through to LIKE-only matching.
    }
  }

  const like = `%${query.trim()}%`;
  const likeRows = db
    .prepare(
      `SELECT id FROM inventory_items
       WHERE deleted_at IS NULL
         AND (sku LIKE ? OR barcode LIKE ? OR serial_number LIKE ? OR name LIKE ?)`
    )
    .all(like, like, like, like);
  for (const row of likeRows) ids.add(row.id);

  return ids;
}

function baseSelect() {
  return `
    SELECT
      i.id, i.external_id, i.sku, i.barcode, i.serial_number, i.name, i.brand, i.model,
      i.status, i.condition, i.quantity, i.reserved_quantity, i.reorder_point,
      i.purchase_price, i.selling_price, i.currency, i.description, i.ocr_text,
      i.icon, i.images, i.colors, i.tags, i.custom_fields, i.added_at, i.updated_at,
      c.path AS category_path, w.name AS warehouse_name, l.code AS location_code
    FROM inventory_items i
    JOIN categories c ON c.id = i.category_id
    LEFT JOIN warehouses w ON w.id = i.warehouse_id
    LEFT JOIN locations l ON l.id = i.location_id
    WHERE i.deleted_at IS NULL
  `;
}

function loadFilteredRows({ category = "All", warehouse = "All", status = "All", model = "All", minPrice = 0, maxPrice = Infinity }) {
  const clauses = [];
  const params = [];

  if (category !== "All") {
    clauses.push("c.path LIKE ?");
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

  const sql = baseSelect() + (clauses.length ? ` AND ${clauses.join(" AND ")}` : "");
  return db.prepare(sql).all(...params);
}

function toDomainItem(row) {
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

function search({ q = "", category = "All", warehouse = "All", status = "All", model = "All", minPrice = 0, maxPrice = Infinity, sort = "relevance", limit = 100 }) {
  const candidateIds = findCandidateIds(q);
  let rows = loadFilteredRows({ category, warehouse, status, model, minPrice, maxPrice });
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

function recordSearchEvent(query, audience, resultCount) {
  try {
    db.prepare(`INSERT INTO search_events (query, audience, result_count) VALUES (?, ?, ?)`).run(
      query || "",
      audience,
      resultCount
    );
  } catch {
    // Analytics are best-effort; never block a search response on logging failures.
  }
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------
app.get("/api/health", (_request, response) => {
  try {
    db.prepare("SELECT 1").get();
    response.json({ ok: true, database: "connected (sqlite)", checkedAt: new Date().toISOString() });
  } catch (error) {
    response.status(503).json({ ok: false, database: "unavailable", message: error.message });
  }
});

// ---------------------------------------------------------------------------
// Admin inventory API — full internal detail (cost, reserved qty, notes, etc.)
// ---------------------------------------------------------------------------
app.get("/api/inventory", requireAdmin, (request, response) => {
  const { q = "", category = "All", warehouse = "All", status = "All", model = "All", sort = "relevance" } = request.query;
  const maxPrice = request.query.maxPrice === "Infinity" ? Infinity : parseNumber(request.query.maxPrice, 10000);
  const page = Math.max(1, Math.trunc(parseNumber(request.query.page, 1)));
  const pageSize = Math.min(Math.max(1, Math.trunc(parseNumber(request.query.pageSize, 50))), 200);

  try {
    const items = search({ q, category, warehouse, status, model, maxPrice, sort, limit: 100000 });

    const total = items.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const currentPage = Math.min(page, totalPages);
    const start = (currentPage - 1) * pageSize;
    const pageItems = items.slice(start, start + pageSize);

    recordSearchEvent(q, "admin", total);
    response.json({ items: pageItems, total, page: currentPage, pageSize, totalPages });
  } catch (error) {
    console.error("[inventory] search failed:", error);
    response.status(500).json({ error: "inventory_search_failed", message: error.message });
  }
});

app.post("/api/admin/upload", requireAdmin, (request, response) => {
  upload.single("image")(request, response, (error) => {
    if (error) {
      console.error("[upload] single upload failed:", error);
      return response.status(400).json({ error: "upload_failed", message: error.message });
    }
    if (!request.file) {
      return response.status(400).json({ error: "upload_failed", message: "No image file received (jpg/png/webp/gif, up to 5MB)." });
    }
    console.log(`[upload] saved ${request.file.filename}`);
    response.json({ url: `/uploads/${request.file.filename}` });
  });
});

app.post("/api/admin/upload-multiple", requireAdmin, (request, response) => {
  upload.array("images", 10)(request, response, (error) => {
    if (error) {
      console.error("[upload] multi upload failed:", error);
      return response.status(400).json({ error: "upload_failed", message: error.message });
    }
    if (!request.files || !request.files.length) {
      return response.status(400).json({ error: "upload_failed", message: "No image files received (jpg/png/webp/gif, up to 5MB each)." });
    }
    console.log(`[upload] saved ${request.files.length} files`);
    response.json({ urls: request.files.map((file) => `/uploads/${file.filename}`) });
  });
});

// Best-effort cleanup for a photo uploaded to an in-progress "Add Item" draft
// that gets removed before the item is ever saved (so it's definitely orphaned).
app.delete("/api/admin/upload", requireAdmin, (request, response) => {
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

app.post("/api/inventory", requireAdmin, (request, response) => {
  const body = request.body || {};
  const required = ["sku", "name", "category"];
  const missing = required.filter((field) => !body[field]);
  if (missing.length) {
    return response.status(400).json({ error: "validation_failed", message: `Missing fields: ${missing.join(", ")}` });
  }

  try {
    const categoryId = upsertLookupByPath(body.category);
    const warehouseId = body.warehouse ? upsertLookup("warehouses", body.warehouse) : null;
    const locationId = warehouseId && body.location ? upsertLocation(warehouseId, body.location) : null;

    const quantity = Math.max(0, parseNumber(body.quantity, 0));
    const reserved = Math.max(0, parseNumber(body.reserved, 0));
    const reorderPoint = Math.max(0, parseNumber(body.reorderPoint, 5));

    const info = db
      .prepare(
        `INSERT INTO inventory_items (
          external_id, sku, barcode, serial_number, name, brand, model,
          category_id, warehouse_id, location_id, status, condition, quantity, reserved_quantity, reorder_point,
          purchase_price, selling_price, currency, description, ocr_text, icon, images, colors, tags, custom_fields
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        body.externalId || `ITM-${Date.now()}`,
        body.sku,
        body.barcode || null,
        body.serial || null,
        body.name,
        body.brand || null,
        body.model || null,
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
        body.icon || body.name.slice(0, 2).toUpperCase(),
        JSON.stringify(body.images || []),
        JSON.stringify(body.colors || ["#c98a4b", "#8a6a3f"]),
        JSON.stringify(body.tags || []),
        JSON.stringify(normalizeCustomFields(body.customFields))
      );

    const id = Number(info.lastInsertRowid);
    const row = db.prepare(`SELECT tags, ocr_text, description, name, brand, model, sku, barcode, serial_number FROM inventory_items WHERE id = ?`).get(id);
    reindexItem(id, { ...row, category_path: body.category });

    console.log(`[inventory] created item ${body.sku} (id ${id})`);
    response.status(201).json({ ok: true, id });
  } catch (error) {
    const message = /UNIQUE constraint failed/.test(error.message)
      ? "An item with that SKU already exists."
      : error.message;
    console.error(`[inventory] create failed for sku ${body.sku}:`, error);
    response.status(400).json({ error: "create_failed", message });
  }
});

app.get("/api/inventory/:id", requireAdmin, (request, response) => {
  const row = db.prepare(`${baseSelect()} AND i.external_id = ?`).get(request.params.id);
  if (!row) {
    return response.status(404).json({ error: "not_found", message: "Item not found." });
  }
  row.tagsText = safeJsonArray(row.tags).join(" ");
  const item = toDomainItem(row);
  item.score = 50;
  response.json(item);
});

app.put("/api/inventory/:id", requireAdmin, (request, response) => {
  const body = request.body || {};
  const required = ["sku", "name", "category"];
  const missing = required.filter((field) => !body[field]);
  if (missing.length) {
    return response.status(400).json({ error: "validation_failed", message: `Missing fields: ${missing.join(", ")}` });
  }

  const existing = db.prepare(`SELECT id FROM inventory_items WHERE external_id = ? AND deleted_at IS NULL`).get(request.params.id);
  if (!existing) {
    return response.status(404).json({ error: "not_found", message: "Item not found." });
  }

  try {
    const categoryId = upsertLookupByPath(body.category);
    const warehouseId = body.warehouse ? upsertLookup("warehouses", body.warehouse) : null;
    const locationId = warehouseId && body.location ? upsertLocation(warehouseId, body.location) : null;

    const quantity = Math.max(0, parseNumber(body.quantity, 0));
    const reserved = Math.max(0, parseNumber(body.reserved, 0));
    const reorderPoint = Math.max(0, parseNumber(body.reorderPoint, 5));

    db.prepare(
      `UPDATE inventory_items SET
        sku = ?, barcode = ?, serial_number = ?, name = ?, brand = ?, model = ?,
        category_id = ?, warehouse_id = ?, location_id = ?, status = ?, condition = ?,
        quantity = ?, reserved_quantity = ?, reorder_point = ?,
        purchase_price = ?, selling_price = ?, currency = ?, description = ?, ocr_text = ?,
        icon = ?, images = ?, colors = ?, tags = ?, custom_fields = ?, updated_at = datetime('now')
      WHERE id = ?`
    ).run(
      body.sku,
      body.barcode || null,
      body.serial || null,
      body.name,
      body.brand || null,
      body.model || null,
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
      body.icon || body.name.slice(0, 2).toUpperCase(),
      JSON.stringify(body.images || []),
      JSON.stringify(body.colors || ["#c98a4b", "#8a6a3f"]),
      JSON.stringify(body.tags || []),
      JSON.stringify(normalizeCustomFields(body.customFields)),
      existing.id
    );

    reindexItem(existing.id, {
      name: body.name,
      brand: body.brand,
      model: body.model,
      sku: body.sku,
      barcode: body.barcode,
      serial_number: body.serial,
      tags: JSON.stringify(body.tags || []),
      ocr_text: body.ocr,
      description: body.description,
      category_path: body.category,
    });

    console.log(`[inventory] updated item ${body.sku} (id ${existing.id})`);
    response.json({ ok: true, id: existing.id });
  } catch (error) {
    const message = /UNIQUE constraint failed/.test(error.message)
      ? "An item with that SKU already exists."
      : error.message;
    console.error(`[inventory] update failed for id ${existing.id}:`, error);
    response.status(400).json({ error: "update_failed", message });
  }
});

app.delete("/api/inventory/:id", requireAdmin, (request, response) => {
  const existing = db.prepare(`SELECT id FROM inventory_items WHERE external_id = ? AND deleted_at IS NULL`).get(request.params.id);
  if (!existing) {
    return response.status(404).json({ error: "not_found", message: "Item not found." });
  }

  db.prepare(`UPDATE inventory_items SET deleted_at = datetime('now') WHERE id = ?`).run(existing.id);
  db.prepare(`DELETE FROM inventory_fts WHERE rowid = ?`).run(existing.id);

  console.log(`[inventory] deleted item id ${existing.id}`);
  response.json({ ok: true });
});

function upsertLookup(table, name) {
  const existing = db.prepare(`SELECT id FROM ${table} WHERE name = ?`).get(name);
  if (existing) return existing.id;
  return Number(db.prepare(`INSERT INTO ${table} (name) VALUES (?)`).run(name).lastInsertRowid);
}

function upsertLookupByPath(pathValue) {
  const existing = db.prepare(`SELECT id FROM categories WHERE path = ?`).get(pathValue);
  if (existing) return existing.id;
  const name = pathValue.split(">").map((part) => part.trim()).at(-1);
  return Number(db.prepare(`INSERT INTO categories (name, path) VALUES (?, ?)`).run(name, pathValue).lastInsertRowid);
}

function upsertLocation(warehouseId, code) {
  const existing = db.prepare(`SELECT id FROM locations WHERE warehouse_id = ? AND code = ?`).get(warehouseId, code);
  if (existing) return existing.id;
  return Number(db.prepare(`INSERT INTO locations (warehouse_id, code) VALUES (?, ?)`).run(warehouseId, code).lastInsertRowid);
}

function reindexItem(id, row) {
  db.prepare(`DELETE FROM inventory_fts WHERE rowid = ?`).run(id);
  const tags = safeJsonArray(row.tags).join(" ");
  db.prepare(
    `INSERT INTO inventory_fts (rowid, name, brand, model, sku, barcode, serial_number, tags, ocr_text, description, category_path)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(id, row.name || "", row.brand || "", row.model || "", row.sku || "", row.barcode || "", row.serial_number || "", tags, row.ocr_text || "", row.description || "", row.category_path || "");
}

app.get("/api/facets", requireAdmin, (request, response) => {
  const { category = "All" } = request.query;
  try {
    // Scoped to categories/warehouses actually used by a live item, so a
    // category left behind by a deleted item doesn't linger in the dropdown.
    const categories = db
      .prepare(
        `SELECT DISTINCT c.path FROM categories c
         JOIN inventory_items i ON i.category_id = c.id
         WHERE i.deleted_at IS NULL
         ORDER BY c.path`
      )
      .all()
      .map((r) => r.path);
    const warehouses = db
      .prepare(
        `SELECT DISTINCT w.name FROM warehouses w
         JOIN inventory_items i ON i.warehouse_id = w.id
         WHERE i.deleted_at IS NULL
         ORDER BY w.name`
      )
      .all()
      .map((r) => r.name);
    const statuses = db
      .prepare("SELECT DISTINCT status FROM inventory_items WHERE deleted_at IS NULL ORDER BY status")
      .all()
      .map((r) => r.status);

    // Scoped to the selected category so the model list stays relevant
    // (e.g. picking "Camera" only offers camera models, not every model in the catalog).
    const modelClauses = ["i.deleted_at IS NULL", "i.model IS NOT NULL", "i.model != ''"];
    const modelParams = [];
    if (category !== "All") {
      modelClauses.push("c.path LIKE ?");
      modelParams.push(`${category}%`);
    }
    const models = db
      .prepare(
        `SELECT DISTINCT i.model FROM inventory_items i
         JOIN categories c ON c.id = i.category_id
         WHERE ${modelClauses.join(" AND ")}
         ORDER BY i.model`
      )
      .all(...modelParams)
      .map((r) => r.model);

    response.json({ categories, warehouses, statuses, models });
  } catch (error) {
    console.error("[facets] failed:", error);
    response.status(500).json({ error: "facets_failed", message: error.message });
  }
});

app.get("/api/dashboard", requireAdmin, (_request, response) => {
  try {
    const row = db
      .prepare(
        `SELECT
          COALESCE(SUM(selling_price * quantity), 0) AS inventory_value,
          COALESCE(SUM(MAX(quantity - reserved_quantity, 0)), 0) AS stock_count,
          SUM(CASE WHEN MAX(quantity - reserved_quantity, 0) <= reorder_point THEN 1 ELSE 0 END) AS low_stock_count,
          COUNT(*) AS item_count
        FROM inventory_items
        WHERE deleted_at IS NULL`
      )
      .get();
    const searches = db.prepare(`SELECT COUNT(*) AS count FROM search_events`).get();
    response.json({ ...row, total_searches: searches.count });
  } catch (error) {
    console.error("[dashboard] failed:", error);
    response.status(500).json({ error: "dashboard_failed", message: error.message });
  }
});

// ---------------------------------------------------------------------------
// Storefront (buyer) API — customer-safe fields only. No cost price, no
// reserved-quantity breakdown, no internal notes: just enough to search,
// browse, and see whether something is currently in stock.
// ---------------------------------------------------------------------------
function toShopItem(item) {
  return {
    id: item.id,
    sku: item.sku,
    name: item.name,
    brand: item.brand,
    model: item.model,
    category: item.category,
    price: item.price,
    currency: item.currency,
    description: item.description,
    icon: item.icon,
    images: item.images,
    image: item.image,
    colors: item.colors,
    tags: item.tags,
    availability: item.availability,
    condition: item.condition,
    inStock: item.availableQuantity > 0 && item.availability !== "Out of Stock",
    availableQuantity: item.availableQuantity,
    score: item.score,
  };
}

app.get("/api/shop/products", (request, response) => {
  const { q = "", category = "All", sort = "relevance" } = request.query;
  const minPrice = parseNumber(request.query.minPrice, 0);
  const maxPrice = parseNumber(request.query.maxPrice, 100000);
  const page = Math.max(1, Math.trunc(parseNumber(request.query.page, 1)));
  const pageSize = Math.min(Math.max(1, Math.trunc(parseNumber(request.query.pageSize, 24))), 100);
  const inStockOnly = request.query.inStockOnly === "true";

  const sellableStatuses = new Set(["Available", "Low Stock", "Reserved", "Out of Stock"]);

  try {
    let items = search({ q, category, warehouse: "All", status: "All", minPrice, maxPrice, sort, limit: 100000 }).filter(
      (item) => sellableStatuses.has(item.status)
    );
    if (inStockOnly) items = items.filter((item) => item.availableQuantity > 0);

    const total = items.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const currentPage = Math.min(page, totalPages);
    const start = (currentPage - 1) * pageSize;
    const pageItems = items.slice(start, start + pageSize);

    recordSearchEvent(q, "shop", total);
    response.json({ items: pageItems.map(toShopItem), total, page: currentPage, pageSize, totalPages });
  } catch (error) {
    console.error("[shop] search failed:", error);
    response.status(500).json({ error: "shop_search_failed", message: error.message });
  }
});

app.get("/api/shop/suggest", (request, response) => {
  const { q = "" } = request.query;
  const limit = Math.min(parseNumber(request.query.limit, 6), 10);

  if (!q.trim()) return response.json({ items: [] });

  const sellableStatuses = new Set(["Available", "Low Stock", "Reserved", "Out of Stock"]);
  try {
    const items = search({ q, warehouse: "All", status: "All", sort: "relevance", limit: 30 })
      .filter((item) => sellableStatuses.has(item.status))
      .slice(0, limit)
      .map((item) => ({
        id: item.id,
        name: item.name,
        icon: item.icon,
        category: item.category.split(">").map((part) => part.trim()).at(-1),
      }));
    response.json({ items });
  } catch (error) {
    console.error("[shop] suggest failed:", error);
    response.status(500).json({ error: "suggest_failed", message: error.message });
  }
});

app.get("/api/shop/products/:id", (request, response) => {
  const row = db.prepare(`${baseSelect()} AND i.external_id = ?`).get(request.params.id);
  if (!row) {
    return response.status(404).json({ error: "not_found", message: "Product not found." });
  }
  row.tagsText = safeJsonArray(row.tags).join(" ");
  const item = toDomainItem(row);
  item.score = 50;
  response.json(toShopItem(item));
});

// One-click "Order" from the storefront: no cart, no customer info — just
// records the order and takes one unit off the shelf like a real sale.
app.post("/api/shop/orders", (request, response) => {
  const { itemId } = request.body || {};
  if (!itemId) {
    return response.status(400).json({ error: "validation_failed", message: "Missing itemId." });
  }

  const row = db
    .prepare(
      `SELECT i.id, i.sku, i.name, i.brand, i.model, i.quantity, i.reserved_quantity, i.selling_price, c.path AS category_path
       FROM inventory_items i
       JOIN categories c ON c.id = i.category_id
       WHERE i.external_id = ? AND i.deleted_at IS NULL`
    )
    .get(itemId);
  if (!row) {
    return response.status(404).json({ error: "not_found", message: "Product not found." });
  }
  if (row.quantity - row.reserved_quantity <= 0) {
    return response.status(400).json({ error: "out_of_stock", message: "This item is currently out of stock." });
  }

  try {
    db.prepare(`UPDATE inventory_items SET quantity = quantity - 1, updated_at = datetime('now') WHERE id = ?`).run(row.id);
    db.prepare(
      `INSERT INTO orders (inventory_item_id, sku, name, brand, model, category, quantity, price) VALUES (?,?,?,?,?,?,?,?)`
    ).run(row.id, row.sku, row.name, row.brand, row.model, row.category_path, 1, row.selling_price);

    const updatedRow = db.prepare(`${baseSelect()} AND i.external_id = ?`).get(itemId);
    updatedRow.tagsText = safeJsonArray(updatedRow.tags).join(" ");
    const updatedItem = toDomainItem(updatedRow);
    updatedItem.score = 50;

    response.status(201).json({ ok: true, item: toShopItem(updatedItem) });
  } catch (error) {
    console.error("[shop] order failed:", error);
    response.status(500).json({ error: "order_failed", message: error.message });
  }
});

app.get("/api/shop/facets", (_request, response) => {
  try {
    const categories = db
      .prepare(
        `SELECT DISTINCT c.path FROM categories c
         JOIN inventory_items i ON i.category_id = c.id
         WHERE i.deleted_at IS NULL
         ORDER BY c.path`
      )
      .all()
      .map((r) => r.path);
    const priceBounds = db
      .prepare(
        `SELECT COALESCE(MIN(selling_price), 0) AS minPrice, COALESCE(MAX(selling_price), 0) AS maxPrice
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
// Admin analytics — order calendar
// ---------------------------------------------------------------------------
const MONTH_PATTERN = /^\d{4}-\d{2}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// ordered_at is stored in UTC. The admin's browser reports its own offset
// (minutes to ADD to UTC to get local time, i.e. -Date#getTimezoneOffset())
// so "which calendar day is this order on" matches the admin's local day
// instead of the UTC day, which otherwise disagree near midnight.
function tzModifier(request) {
  const raw = Math.trunc(parseNumber(request.query.tzOffset, 0));
  const clamped = Math.max(-840, Math.min(840, raw)); // real-world offsets span -12:00..+14:00
  return `${clamped >= 0 ? "+" : ""}${clamped} minutes`;
}

app.get("/api/analytics/orders/summary", requireAdmin, (request, response) => {
  const { month } = request.query;
  if (!MONTH_PATTERN.test(month || "")) {
    return response.status(400).json({ error: "validation_failed", message: "month must be YYYY-MM." });
  }

  try {
    const modifier = tzModifier(request);
    const rows = db
      .prepare(
        `SELECT date(ordered_at, ?) AS day, COUNT(*) AS count
         FROM orders
         WHERE strftime('%Y-%m', ordered_at, ?) = ?
         GROUP BY day`
      )
      .all(modifier, modifier, month);
    const days = Object.fromEntries(rows.map((row) => [row.day, row.count]));
    response.json({ days });
  } catch (error) {
    console.error("[analytics] order summary failed:", error);
    response.status(500).json({ error: "analytics_failed", message: error.message });
  }
});

app.get("/api/analytics/orders/day", requireAdmin, (request, response) => {
  const { date } = request.query;
  if (!DATE_PATTERN.test(date || "")) {
    return response.status(400).json({ error: "validation_failed", message: "date must be YYYY-MM-DD." });
  }

  try {
    const modifier = tzModifier(request);
    const rows = db
      .prepare(
        `SELECT id, sku, name, brand, model, category, quantity, price, ordered_at AS orderedAt
         FROM orders
         WHERE date(ordered_at, ?) = ?
         ORDER BY ordered_at DESC`
      )
      .all(modifier, date);
    response.json({ orders: rows });
  } catch (error) {
    console.error("[analytics] order day lookup failed:", error);
    response.status(500).json({ error: "analytics_failed", message: error.message });
  }
});

app.listen(port, () => {
  console.log(`PicsArt Shop running on http://localhost:${port}`);
  console.log(`  Storefront:     http://localhost:${port}/index.html`);
  console.log(`  Admin console:  http://localhost:${port}/admin.html`);
});
