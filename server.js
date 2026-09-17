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
import { isUniqueViolation } from "./db/client.js";
import {
  buildFtsQuery,
  expandTerms,
  scoreRow,
  SORTERS,
  availabilityStatus,
} from "./lib/search.js";
import QRCode from "qrcode";

import {
  ACCESS_COOKIE,
  ACCESS_TOKEN_TTL_SECONDS,
  CHALLENGE_COOKIE,
  CHALLENGE_TTL_SECONDS,
  CSRF_COOKIE,
  CSRF_HEADER,
  REFRESH_COOKIE,
  REFRESH_COOKIE_PATH,
  REFRESH_TOKEN_TTL_SECONDS,
  cookieAttributes,
  createCsrfToken,
  createFamilyId,
  createRefreshToken,
  csrfTokensMatch,
  hashPassword,
  hashRefreshToken,
  normalizeEmail,
  passwordProblems,
  serializeCookie,
  signAccessToken,
  validateCredentials,
  verifyAccessToken,
  verifyPassword,
} from "./lib/auth.js";
import {
  createNumericCode,
  createRecoveryCodes,
  createTotpSecret,
  hashCode,
  hashRecoveryCode,
  otpauthUrl,
  verifyTotp,
} from "./lib/totp.js";
import {
  newSignInEmail,
  passwordChangedEmail,
  passwordResetEmail,
  sendMail,
  twoFactorEnabledEmail,
  verificationEmail,
} from "./lib/mailer.js";

const app = express();
const port = Number(process.env.PORT || 3000);

// Express 4 does not catch exceptions thrown inside async handlers: an
// unhandled rejection in any single route takes the entire process down, so one
// malformed request could close the shop. Wrapping route registration once
// gives every handler the same safety net, and failures become a 500 for that
// one request instead of an outage.
for (const method of ["get", "post", "put", "patch", "delete"]) {
  const register = app[method].bind(app);
  app[method] = (routePath, ...handlers) =>
    register(
      routePath,
      ...handlers.map((handler) =>
        typeof handler === "function" && handler.length < 4
          ? function wrapped(request, response, next) {
              try {
                const result = handler(request, response, next);
                if (result && typeof result.catch === "function") result.catch(next);
                return result;
              } catch (error) {
                return next(error);
              }
            }
          : handler
      )
    );
}
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = path.join(__dirname, "public", "uploads");
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

let db;
try {
  db = await openDatabase();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

// PostgreSQL equivalent of SQLite's datetime('now') — a UTC timestamp in the
// same 'YYYY-MM-DD HH:MM:SS' text format every stored timestamp uses.
const NOW_SQL = "to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')";

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

// ---------------------------------------------------------------------------
// Storefront customer sessions
//
// Two cookies, both HttpOnly and SameSite=Strict so neither injected script nor
// another site can read or send them:
//
//   atlas_access   short-lived signed token, proves who you are on every request
//   atlas_refresh  long-lived opaque token, scoped to /api/auth/refresh only
//
// A third cookie (atlas_csrf) is deliberately readable by our own JavaScript so
// it can be echoed back in a header — the double-submit check below.
// ---------------------------------------------------------------------------
const AUTH_SECRET = process.env.AUTH_SECRET || crypto.randomBytes(32).toString("hex");

if (!process.env.AUTH_SECRET) {
  console.warn(
    "WARNING: AUTH_SECRET is not set in .env — a random one was generated, so every customer is signed out when the server restarts. Set a real one before deploying."
  );
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function isSecureRequest(request) {
  return request.secure || request.headers["x-forwarded-proto"] === "https";
}

function issueCookies(response, request, { accessToken, refreshToken, csrfToken }) {
  const secure = isSecureRequest(request);
  const cookies = [];

  if (accessToken !== undefined) {
    cookies.push(
      serializeCookie(
        ACCESS_COOKIE,
        accessToken,
        cookieAttributes({ secure, maxAgeSeconds: accessToken ? ACCESS_TOKEN_TTL_SECONDS : 0 })
      )
    );
  }
  if (refreshToken !== undefined) {
    cookies.push(
      serializeCookie(
        REFRESH_COOKIE,
        refreshToken,
        cookieAttributes({
          secure,
          maxAgeSeconds: refreshToken ? REFRESH_TOKEN_TTL_SECONDS : 0,
          path: REFRESH_COOKIE_PATH,
        })
      )
    );
  }
  if (csrfToken !== undefined) {
    // Not HttpOnly on purpose: the page has to read it to echo it back. It is
    // not a credential — it only proves the request came from our own page.
    cookies.push(
      `${CSRF_COOKIE}=${encodeURIComponent(csrfToken)}; Path=/; SameSite=Strict${secure ? "; Secure" : ""}; Max-Age=${
        csrfToken ? REFRESH_TOKEN_TTL_SECONDS : 0
      }`
    );
  }

  for (const cookie of cookies) response.append("Set-Cookie", cookie);
}

function clearAuthCookies(response, request) {
  issueCookies(response, request, { accessToken: "", refreshToken: "" });
  response.append(
    "Set-Cookie",
    serializeCookie(CHALLENGE_COOKIE, "", cookieAttributes({ secure: isSecureRequest(request), maxAgeSeconds: 0 }))
  );
}

// Access tokens are verified by signature alone, with no database round trip.
// That makes them fast but unrevokable — so this map holds the one thing that
// can invalidate them early: the instant each account last signed everything
// out. It mirrors users.sessions_valid_from and is loaded at startup.
const sessionEpochs = new Map(); // userId -> unix seconds

for (const row of await db.prepare("SELECT id, sessions_valid_from FROM users WHERE sessions_valid_from IS NOT NULL").all()) {
  sessionEpochs.set(row.id, row.sessions_valid_from);
}

// Milliseconds, not seconds. A JWT's `iat` has one-second resolution, so a
// token minted in the same second as a revocation would slip through — which is
// exactly what happens when someone resets their password and the new session
// starts in the same tick. Access tokens therefore carry their own millisecond
// timestamp.
async function invalidateAccessTokens(userId) {
  const epoch = Date.now();
  sessionEpochs.set(userId, epoch);
  await db.prepare("UPDATE users SET sessions_valid_from = ? WHERE id = ?").run(epoch, userId);
  return epoch;
}

function mintAccessToken(user) {
  return signAccessToken({ sub: user.id, email: user.email, ms: Date.now() }, AUTH_SECRET);
}

// Reads the access token, if there is a valid one. Never rejects: routes decide
// for themselves whether a signed-in customer is required.
function attachUser(request, _response, next) {
  const cookies = parseCookies(request.headers.cookie);
  const payload = verifyAccessToken(cookies[ACCESS_COOKIE], AUTH_SECRET);
  const epoch = payload ? sessionEpochs.get(payload.sub) : undefined;
  const issuedAt = payload ? payload.ms ?? payload.iat * 1000 : 0;
  const revoked = epoch !== undefined && issuedAt < epoch;
  request.user = payload && !revoked ? { id: payload.sub, email: payload.email } : null;
  next();
}

// Every visitor gets a CSRF token, not just signed-in ones, so that logging in
// is itself protected against forgery.
function ensureCsrfCookie(request, response, next) {
  const cookies = parseCookies(request.headers.cookie);
  request.csrfToken = cookies[CSRF_COOKIE];
  if (!request.csrfToken) {
    request.csrfToken = createCsrfToken();
    issueCookies(response, request, { csrfToken: request.csrfToken });
  }
  next();
}

// Double-submit check plus an origin check, applied to every state-changing
// customer request. SameSite=Strict already blocks the cross-site case; this is
// the layer that still holds if a browser ever fails to honour it.
function requireCsrf(request, response, next) {
  if (SAFE_METHODS.has(request.method)) return next();

  const origin = request.headers.origin;
  if (origin) {
    let originHost = null;
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = null;
    }
    if (originHost !== request.headers.host) {
      return response.status(403).json({ error: "csrf_failed", message: "Cross-origin request rejected." });
    }
  }

  const cookies = parseCookies(request.headers.cookie);
  if (!csrfTokensMatch(cookies[CSRF_COOKIE], request.headers[CSRF_HEADER])) {
    return response.status(403).json({ error: "csrf_failed", message: "Missing or invalid CSRF token." });
  }
  return next();
}

function requireUser(request, response, next) {
  if (request.user) return next();
  return response.status(401).json({ error: "auth_required", message: "Please sign in to continue." });
}

// Small in-memory throttle for the credential endpoints. Enough to make online
// password guessing impractical on a single-instance deployment.
const attemptBuckets = new Map(); // key -> { count, resetAt }

function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  const bucket = attemptBuckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    attemptBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= limit;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of attemptBuckets) if (now > bucket.resetAt) attemptBuckets.delete(key);
}, 10 * 60 * 1000).unref();

// A per-request nonce lets the admin login page keep its inline script while
// script-src stays locked to our own origin.
app.use((_request, response, next) => {
  response.locals.cspNonce = crypto.randomBytes(16).toString("base64");
  next();
});

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", (_request, response) => `'nonce-${response.locals.cspNonce}'`],
        // React sets element styles through the style attribute, which counts
        // as inline. Scripts — the part that matters for XSS — stay restricted.
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:"],
        fontSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
  })
);
app.use(cors());
app.use(express.json({ limit: "100kb" }));
app.use(attachUser);
app.use(ensureCsrfCookie);

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
    <script nonce="${response.locals.cspNonce}">
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

function blankToNull(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text ? text : null;
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
// Two-letter tile shown when an item has no photo. Falls back to a neutral
// placeholder when there is no name to derive it from.
function defaultIcon(name) {
  return String(name ?? "").trim().slice(0, 2).toUpperCase() || "IT";
}

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
async function findCandidateIds(query) {
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

function baseSelect() {
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

async function loadFilteredRows({ category = "All", warehouse = "All", status = "All", model = "All", minPrice = 0, maxPrice = Infinity }) {
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

async function search({ q = "", category = "All", warehouse = "All", status = "All", model = "All", minPrice = 0, maxPrice = Infinity, sort = "relevance", limit = 100 }) {
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

async function recordSearchEvent(query, audience, resultCount) {
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

// ---------------------------------------------------------------------------
// Customer accounts
//
// The lifecycle, in the order a customer meets it:
//
//   lookup          does this address have an account? (drives the two-step form)
//   register        creates an unverified account and emails a code
//   verify-email    the code proves the address; only now does a session exist
//   login           password, then a two-step code if the account has one
//   refresh         rotates the session in the background
//   forgot/reset    the way back in, which also signs out every device
//   profile/password/sessions/totp   account management
// ---------------------------------------------------------------------------

// Comparing against a throwaway hash when no account matches keeps the response
// time for "unknown email" and "wrong password" indistinguishable.
const DUMMY_PASSWORD_HASH = await hashPassword(crypto.randomBytes(16).toString("hex"));

const CODE_TTL_SECONDS = 15 * 60;
const CODE_MAX_ATTEMPTS = 5;

function publicUser(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.name || null,
    createdAt: row.created_at,
    emailVerified: Boolean(row.email_verified_at),
    twoFactorEnabled: Boolean(row.totp_enabled_at),
  };
}

function utcNow() {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

function utcIn(seconds) {
  return new Date(Date.now() + seconds * 1000).toISOString().slice(0, 19).replace("T", " ");
}

function clientDescription(request) {
  return {
    userAgent: String(request.headers["user-agent"] || "").slice(0, 200),
    ip: request.ip,
  };
}

// Issues a fresh access token plus a refresh token belonging to `familyId`
// (a new family for a new login, the existing one when rotating).
async function startSession(request, response, user, { familyId = createFamilyId(), persistent = true } = {}) {
  const refreshToken = createRefreshToken();
  const client = clientDescription(request);
  await db
    .prepare(
      `INSERT INTO refresh_tokens (user_id, token_hash, family_id, expires_at, user_agent, ip, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(user.id, hashRefreshToken(refreshToken), familyId, utcIn(REFRESH_TOKEN_TTL_SECONDS), client.userAgent, client.ip, utcNow());

  const secure = isSecureRequest(request);
  response.append(
    "Set-Cookie",
    serializeCookie(
      ACCESS_COOKIE,
      mintAccessToken(user),
      cookieAttributes({ secure, maxAgeSeconds: ACCESS_TOKEN_TTL_SECONDS, persistent })
    )
  );
  response.append(
    "Set-Cookie",
    serializeCookie(
      REFRESH_COOKIE,
      refreshToken,
      cookieAttributes({ secure, maxAgeSeconds: REFRESH_TOKEN_TTL_SECONDS, path: REFRESH_COOKIE_PATH, persistent })
    )
  );
  // Rotated alongside the session so a token captured before sign-in can't be
  // reused afterwards.
  issueCookies(response, request, { csrfToken: createCsrfToken() });
}

// ---------------------------------------------------------------------------
// One-time codes
// ---------------------------------------------------------------------------
async function issueCode(userId, purpose) {
  // Only the newest code for a purpose is valid — requesting a new one
  // invalidates whatever was sent before.
  await db.prepare("DELETE FROM auth_codes WHERE user_id = ? AND purpose = ?").run(userId, purpose);
  const code = createNumericCode(6);
  await db
    .prepare("INSERT INTO auth_codes (user_id, purpose, code_hash, expires_at) VALUES (?, ?, ?, ?)")
    .run(userId, purpose, hashCode(code), utcIn(CODE_TTL_SECONDS));
  return code;
}

// Returns null when the code is good; a message when it isn't. Wrong guesses are
// counted so a six-digit code can't simply be enumerated.
async function consumeCode(userId, purpose, code) {
  const row = await db
    .prepare(
      `SELECT id, code_hash, attempts, expires_at, used_at FROM auth_codes
       WHERE user_id = ? AND purpose = ? ORDER BY id DESC LIMIT 1`
    )
    .get(userId, purpose);

  if (!row || row.used_at) return "That code is no longer valid. Request a new one.";
  if (row.expires_at < utcNow()) return "That code has expired. Request a new one.";
  if (row.attempts >= CODE_MAX_ATTEMPTS) return "Too many incorrect attempts. Request a new code.";

  const cleaned = String(code ?? "").replace(/\D/g, "");
  if (hashCode(cleaned) !== row.code_hash) {
    await db.prepare("UPDATE auth_codes SET attempts = attempts + 1 WHERE id = ?").run(row.id);
    const left = CODE_MAX_ATTEMPTS - (row.attempts + 1);
    return left > 0 ? `Incorrect code. ${left} attempt${left === 1 ? "" : "s"} left.` : "Too many incorrect attempts. Request a new code.";
  }

  await db.prepare(`UPDATE auth_codes SET used_at = ${NOW_SQL} WHERE id = ?`).run(row.id);
  return null;
}

async function revokeAllSessions(userId, exceptFamilyId = null) {
  // Kills the refresh tokens *and* every access token already out there. The
  // device performing the action is given a fresh session immediately after.
  await invalidateAccessTokens(userId);
  if (exceptFamilyId) {
    await db
      .prepare(`UPDATE refresh_tokens SET revoked_at = ${NOW_SQL} WHERE user_id = ? AND family_id <> ? AND revoked_at IS NULL`)
      .run(userId, exceptFamilyId);
  } else {
    await db.prepare(`UPDATE refresh_tokens SET revoked_at = ${NOW_SQL} WHERE user_id = ? AND revoked_at IS NULL`).run(userId);
  }
}

function findUserByEmail(email) {
  return db
    .prepare(
      `SELECT id, email, name, password_hash, created_at, last_login_at, email_verified_at,
              totp_secret, totp_enabled_at, recovery_codes
       FROM users WHERE email = ?`
    )
    .get(email);
}

// ---------------------------------------------------------------------------
// Step 1 — who is this?
//
// The two-step form needs to know whether to ask for a password or offer to
// create an account. This does confirm whether an address is registered, which
// is the same trade every large shop makes (Amazon's sign-in page says "We
// cannot find an account with that email address"); registration has to reject
// duplicates anyway, so the fact is already discoverable. It is rate limited so
// it can't be used to harvest a list.
// ---------------------------------------------------------------------------
app.post("/api/auth/lookup", requireCsrf, async (request, response) => {
  const email = normalizeEmail(request.body?.email);
  if (!email) return response.status(400).json({ error: "validation_failed", message: "Enter an email address." });
  if (!rateLimit(`lookup:${request.ip}`, 30, 15 * 60 * 1000)) {
    return response.status(429).json({ error: "rate_limited", message: "Too many attempts. Try again in a few minutes." });
  }

  try {
    const user = await findUserByEmail(email);
    response.json({
      exists: Boolean(user),
      // An account that never finished verifying should resume at the code step
      // rather than being asked for a password it can't yet use.
      pendingVerification: Boolean(user && !user.email_verified_at),
    });
  } catch (error) {
    console.error("[auth] lookup failed:", error);
    response.status(500).json({ error: "lookup_failed", message: error.message });
  }
});

// ---------------------------------------------------------------------------
// Step 2a — create an account. No session is issued here: the account is inert
// until the emailed code proves the address is real.
// ---------------------------------------------------------------------------
app.post("/api/auth/register", requireCsrf, async (request, response) => {
  const { email, password, name } = request.body || {};

  const problems = validateCredentials({ email, password, name });
  if (problems.length) {
    return response.status(400).json({
      error: "validation_failed",
      message: problems.map((problem) => problem.message).join(" "),
      problems,
    });
  }
  if (!rateLimit(`register:${request.ip}`, 10, 60 * 60 * 1000)) {
    return response.status(429).json({ error: "rate_limited", message: "Too many attempts. Try again later." });
  }

  const normalizedEmail = normalizeEmail(email);
  try {
    const existing = await findUserByEmail(normalizedEmail);

    if (existing?.email_verified_at) {
      return response.status(409).json({ error: "email_taken", message: "An account with that email already exists." });
    }

    let userId;
    if (existing) {
      // An abandoned signup: take the new password and send a fresh code rather
      // than stranding the address forever.
      userId = existing.id;
      await db
        .prepare("UPDATE users SET password_hash = ?, name = ? WHERE id = ?")
        .run(await hashPassword(password), String(name ?? "").trim() || existing.name, userId);
    } else {
      const created = await db
        .prepare("INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?) RETURNING id")
        .get(normalizedEmail, await hashPassword(password), String(name ?? "").trim() || null);
      userId = created.id;
    }

    const code = await issueCode(userId, "verify");
    const message = verificationEmail(code);
    await sendMail({ to: normalizedEmail, ...message });

    console.log(`[auth] verification code issued for ${normalizedEmail}`);
    response.status(201).json({ verificationRequired: true, email: normalizedEmail });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return response.status(409).json({ error: "email_taken", message: "An account with that email already exists." });
    }
    console.error("[auth] register failed:", error);
    response.status(500).json({ error: "register_failed", message: error.message });
  }
});

app.post("/api/auth/verify-email", requireCsrf, async (request, response) => {
  const email = normalizeEmail(request.body?.email);
  if (!rateLimit(`verify:${request.ip}`, 30, 15 * 60 * 1000)) {
    return response.status(429).json({ error: "rate_limited", message: "Too many attempts. Try again in a few minutes." });
  }

  try {
    const user = await findUserByEmail(email);
    if (!user) return response.status(400).json({ error: "invalid_code", message: "That code is no longer valid. Request a new one." });
    if (user.email_verified_at) {
      return response.status(409).json({ error: "already_verified", message: "That address is already verified. Please sign in." });
    }

    const problem = await consumeCode(user.id, "verify", request.body?.code);
    if (problem) return response.status(400).json({ error: "invalid_code", message: problem });

    await db.prepare(`UPDATE users SET email_verified_at = ${NOW_SQL}, last_login_at = ${NOW_SQL} WHERE id = ?`).run(user.id);
    await startSession(request, response, user, { persistent: request.body?.remember !== false });

    console.log(`[auth] verified ${email}`);
    response.json({ user: publicUser({ ...user, email_verified_at: utcNow() }) });
  } catch (error) {
    console.error("[auth] verify failed:", error);
    response.status(500).json({ error: "verify_failed", message: error.message });
  }
});

// Re-send a verification or reset code. Answers the same way whether or not the
// address exists, and is throttled so it can't be used to send someone mail
// repeatedly.
app.post("/api/auth/resend-code", requireCsrf, async (request, response) => {
  const email = normalizeEmail(request.body?.email);
  const purpose = request.body?.purpose === "reset" ? "reset" : "verify";

  if (!rateLimit(`resend:${email}`, 5, 15 * 60 * 1000) || !rateLimit(`resend-ip:${request.ip}`, 20, 60 * 60 * 1000)) {
    return response.status(429).json({ error: "rate_limited", message: "Too many requests. Try again in a few minutes." });
  }

  try {
    const user = await findUserByEmail(email);
    if (user && (purpose === "reset" || !user.email_verified_at)) {
      const code = await issueCode(user.id, purpose);
      const message = purpose === "reset" ? passwordResetEmail(code) : verificationEmail(code);
      await sendMail({ to: email, ...message });
    }
    response.json({ ok: true });
  } catch (error) {
    console.error("[auth] resend failed:", error);
    response.status(500).json({ error: "resend_failed", message: error.message });
  }
});

// ---------------------------------------------------------------------------
// Step 2b — sign in
// ---------------------------------------------------------------------------
app.post("/api/auth/login", requireCsrf, async (request, response) => {
  const { email, password } = request.body || {};
  const remember = request.body?.remember !== false;
  const normalizedEmail = normalizeEmail(email);

  // Throttled per address and per client, so neither one account nor one
  // attacker can be hammered.
  const allowed =
    rateLimit(`login-ip:${request.ip}`, 20, 15 * 60 * 1000) &&
    rateLimit(`login-email:${normalizedEmail}`, 10, 15 * 60 * 1000);
  if (!allowed) {
    return response.status(429).json({ error: "rate_limited", message: "Too many attempts. Try again in a few minutes." });
  }

  try {
    const user = await findUserByEmail(normalizedEmail);
    const ok = user
      ? await verifyPassword(String(password ?? ""), user.password_hash)
      : await verifyPassword(String(password ?? ""), DUMMY_PASSWORD_HASH);

    // One message for both failures: never reveal whether a password was close.
    if (!user || !ok) {
      console.warn(`[auth] failed login for ${normalizedEmail || "(no email)"} from ${request.ip}`);
      return response.status(401).json({ error: "invalid_credentials", message: "Incorrect email or password." });
    }

    if (!user.email_verified_at) {
      const code = await issueCode(user.id, "verify");
      await sendMail({ to: normalizedEmail, ...verificationEmail(code) });
      return response.status(403).json({
        error: "verification_required",
        message: "Confirm your email address to finish setting up your account. We've sent you a new code.",
        email: normalizedEmail,
      });
    }

    // Two-step verification: the password was right, but it isn't a session yet.
    if (user.totp_enabled_at) {
      response.append(
        "Set-Cookie",
        serializeCookie(
          CHALLENGE_COOKIE,
          signAccessToken({ sub: user.id, purpose: "totp", remember }, AUTH_SECRET, CHALLENGE_TTL_SECONDS),
          cookieAttributes({ secure: isSecureRequest(request), maxAgeSeconds: CHALLENGE_TTL_SECONDS })
        )
      );
      return response.json({ requiresTwoFactor: true });
    }

    await completeLogin(request, response, user, remember);
    response.json({ user: publicUser(user) });
  } catch (error) {
    console.error("[auth] login failed:", error);
    response.status(500).json({ error: "login_failed", message: error.message });
  }
});

async function completeLogin(request, response, user, remember) {
  await db.prepare(`UPDATE users SET last_login_at = ${NOW_SQL} WHERE id = ?`).run(user.id);
  // Housekeeping: drop this account's dead tokens on the way through.
  await db.prepare("DELETE FROM refresh_tokens WHERE user_id = ? AND expires_at < ?").run(user.id, utcNow());
  await startSession(request, response, user, { persistent: remember });

  const client = clientDescription(request);
  // Fire-and-forget: a slow mail server must not slow down signing in.
  sendMail({ to: user.email, ...newSignInEmail({ when: utcNow(), ...client }) }).catch(() => {});
  console.log(`[auth] customer login ${user.email}`);
}

app.post("/api/auth/two-factor", requireCsrf, async (request, response) => {
  const cookies = parseCookies(request.headers.cookie);
  const challenge = verifyAccessToken(cookies[CHALLENGE_COOKIE], AUTH_SECRET);
  if (!challenge || challenge.purpose !== "totp") {
    return response.status(401).json({ error: "challenge_expired", message: "That took too long. Please sign in again." });
  }
  if (!rateLimit(`totp:${challenge.sub}`, 10, 15 * 60 * 1000)) {
    return response.status(429).json({ error: "rate_limited", message: "Too many attempts. Try again in a few minutes." });
  }

  try {
    const user = await db
      .prepare(
        `SELECT id, email, name, created_at, email_verified_at, totp_secret, totp_enabled_at, recovery_codes
         FROM users WHERE id = ?`
      )
      .get(challenge.sub);
    if (!user?.totp_enabled_at) {
      return response.status(401).json({ error: "challenge_expired", message: "Please sign in again." });
    }

    const submitted = String(request.body?.code ?? "");
    let accepted = verifyTotp(user.totp_secret, submitted);

    // A recovery code works once, and is spent whether or not it was the last one.
    if (!accepted) {
      const remaining = safeJsonArray(user.recovery_codes);
      const hashed = hashRecoveryCode(submitted);
      const index = remaining.indexOf(hashed);
      if (index !== -1) {
        remaining.splice(index, 1);
        await db.prepare("UPDATE users SET recovery_codes = ? WHERE id = ?").run(JSON.stringify(remaining), user.id);
        accepted = true;
        console.warn(`[auth] recovery code used for ${user.email}; ${remaining.length} left`);
      }
    }

    if (!accepted) {
      return response.status(401).json({ error: "invalid_code", message: "That code isn't right. Check your authenticator app." });
    }

    response.append(
      "Set-Cookie",
      serializeCookie(CHALLENGE_COOKIE, "", cookieAttributes({ secure: isSecureRequest(request), maxAgeSeconds: 0 }))
    );
    await completeLogin(request, response, user, challenge.remember !== false);
    response.json({ user: publicUser(user) });
  } catch (error) {
    console.error("[auth] two-factor failed:", error);
    response.status(500).json({ error: "two_factor_failed", message: error.message });
  }
});

// ---------------------------------------------------------------------------
// Forgotten passwords
// ---------------------------------------------------------------------------
app.post("/api/auth/forgot-password", requireCsrf, async (request, response) => {
  const email = normalizeEmail(request.body?.email);
  if (!rateLimit(`forgot:${email}`, 5, 15 * 60 * 1000) || !rateLimit(`forgot-ip:${request.ip}`, 20, 60 * 60 * 1000)) {
    return response.status(429).json({ error: "rate_limited", message: "Too many requests. Try again in a few minutes." });
  }

  try {
    const user = await findUserByEmail(email);
    if (user) {
      const code = await issueCode(user.id, "reset");
      await sendMail({ to: email, ...passwordResetEmail(code) });
      console.log(`[auth] password reset code issued for ${email}`);
    }
    // Always the same answer: this endpoint needs no account to exist, and
    // shouldn't become a way to test addresses.
    response.json({ ok: true });
  } catch (error) {
    console.error("[auth] forgot-password failed:", error);
    response.status(500).json({ error: "forgot_failed", message: error.message });
  }
});

app.post("/api/auth/reset-password", requireCsrf, async (request, response) => {
  const email = normalizeEmail(request.body?.email);
  const { code, password } = request.body || {};

  if (!rateLimit(`reset:${request.ip}`, 20, 15 * 60 * 1000)) {
    return response.status(429).json({ error: "rate_limited", message: "Too many attempts. Try again in a few minutes." });
  }

  const problem = passwordProblems(password, email);
  if (problem) {
    return response.status(400).json({ error: "validation_failed", message: problem.message, problems: [problem] });
  }

  try {
    const user = await findUserByEmail(email);
    if (!user) return response.status(400).json({ error: "invalid_code", message: "That code is no longer valid. Request a new one." });

    const codeProblem = await consumeCode(user.id, "reset", code);
    if (codeProblem) return response.status(400).json({ error: "invalid_code", message: codeProblem });

    await db
      .prepare(`UPDATE users SET password_hash = ?, password_changed_at = ${NOW_SQL}, email_verified_at = COALESCE(email_verified_at, ${NOW_SQL}) WHERE id = ?`)
      .run(await hashPassword(password), user.id);

    // Whoever knew the old password — including whoever the customer is resetting
    // because of — loses every session.
    await revokeAllSessions(user.id);
    sendMail({ to: user.email, ...passwordChangedEmail() }).catch(() => {});

    await startSession(request, response, user);
    console.log(`[auth] password reset for ${email}`);
    response.json({ user: publicUser({ ...user, email_verified_at: user.email_verified_at || utcNow() }) });
  } catch (error) {
    console.error("[auth] reset-password failed:", error);
    response.status(500).json({ error: "reset_failed", message: error.message });
  }
});

// ---------------------------------------------------------------------------
// Session upkeep
// ---------------------------------------------------------------------------

// Rotation with reuse detection. A refresh token is single-use: presenting one
// that has already been exchanged means it leaked, so the entire family — every
// token descended from that login — is revoked.
app.post("/api/auth/refresh", requireCsrf, async (request, response) => {
  const cookies = parseCookies(request.headers.cookie);
  const presented = cookies[REFRESH_COOKIE];
  if (!presented) {
    return response.status(401).json({ error: "auth_required", message: "Not signed in." });
  }
  if (!rateLimit(`refresh:${request.ip}`, 120, 15 * 60 * 1000)) {
    return response.status(429).json({ error: "rate_limited", message: "Too many attempts. Try again later." });
  }

  try {
    const record = await db
      .prepare(
        `SELECT t.id, t.user_id, t.family_id, t.expires_at, t.used_at, t.revoked_at,
                u.id AS uid, u.email, u.name, u.created_at, u.email_verified_at, u.totp_enabled_at
         FROM refresh_tokens t
         JOIN users u ON u.id = t.user_id
         WHERE t.token_hash = ?`
      )
      .get(hashRefreshToken(presented));

    if (!record) {
      clearAuthCookies(response, request);
      return response.status(401).json({ error: "auth_required", message: "Session expired. Please sign in again." });
    }

    if (record.used_at || record.revoked_at) {
      await db
        .prepare(`UPDATE refresh_tokens SET revoked_at = ${NOW_SQL} WHERE family_id = ? AND revoked_at IS NULL`)
        .run(record.family_id);
      clearAuthCookies(response, request);
      console.warn(`[auth] refresh token reuse detected for user ${record.user_id}; session family revoked`);
      return response.status(401).json({ error: "auth_required", message: "Session expired. Please sign in again." });
    }

    if (record.expires_at < utcNow()) {
      clearAuthCookies(response, request);
      return response.status(401).json({ error: "auth_required", message: "Session expired. Please sign in again." });
    }

    await db.prepare(`UPDATE refresh_tokens SET used_at = ${NOW_SQL}, last_used_at = ${NOW_SQL} WHERE id = ?`).run(record.id);
    const user = {
      id: record.uid,
      email: record.email,
      name: record.name,
      created_at: record.created_at,
      email_verified_at: record.email_verified_at,
      totp_enabled_at: record.totp_enabled_at,
    };
    await startSession(request, response, user, { familyId: record.family_id });
    response.json({ user: publicUser(user) });
  } catch (error) {
    console.error("[auth] refresh failed:", error);
    response.status(500).json({ error: "refresh_failed", message: error.message });
  }
});

app.post("/api/auth/logout", requireCsrf, async (request, response) => {
  const cookies = parseCookies(request.headers.cookie);
  const presented = cookies[REFRESH_COOKIE];

  try {
    if (presented) {
      // Revoke the whole family, so no outstanding token from this login works.
      await db
        .prepare(
          `UPDATE refresh_tokens SET revoked_at = ${NOW_SQL}
           WHERE family_id = (SELECT family_id FROM refresh_tokens WHERE token_hash = ?)
             AND revoked_at IS NULL`
        )
        .run(hashRefreshToken(presented));
    }
  } catch (error) {
    // Signing out must succeed for the browser even if the bookkeeping fails.
    console.error("[auth] logout cleanup failed:", error);
  }

  clearAuthCookies(response, request);
  response.json({ ok: true });
});

// Called on page load to restore a session. Returns null rather than 401 so a
// signed-out visit isn't an error in the console on every load.
app.get("/api/auth/me", async (request, response) => {
  if (!request.user) return response.json({ user: null });
  try {
    const row = await db
      .prepare("SELECT id, email, name, created_at, email_verified_at, totp_enabled_at FROM users WHERE id = ?")
      .get(request.user.id);
    response.json({ user: row ? publicUser(row) : null });
  } catch (error) {
    console.error("[auth] me failed:", error);
    response.status(500).json({ error: "me_failed", message: error.message });
  }
});

// Guarantees the caller has a CSRF cookie before it posts anything.
app.get("/api/auth/csrf", (request, response) => {
  response.json({ csrfToken: request.csrfToken });
});

// ---------------------------------------------------------------------------
// Account management
// ---------------------------------------------------------------------------
app.patch("/api/auth/profile", requireUser, requireCsrf, async (request, response) => {
  const name = String(request.body?.name ?? "").trim();
  if (name.length > 100) {
    return response.status(400).json({ error: "validation_failed", message: "Name must be at most 100 characters." });
  }

  try {
    const row = await db
      .prepare("UPDATE users SET name = ? WHERE id = ? RETURNING id, email, name, created_at, email_verified_at, totp_enabled_at")
      .get(name || null, request.user.id);
    response.json({ user: publicUser(row) });
  } catch (error) {
    console.error("[auth] profile update failed:", error);
    response.status(500).json({ error: "profile_failed", message: error.message });
  }
});

app.post("/api/auth/change-password", requireUser, requireCsrf, async (request, response) => {
  const { currentPassword, newPassword } = request.body || {};

  try {
    const user = await db.prepare("SELECT id, email, password_hash FROM users WHERE id = ?").get(request.user.id);
    if (!user || !(await verifyPassword(String(currentPassword ?? ""), user.password_hash))) {
      return response.status(401).json({ error: "invalid_credentials", message: "Your current password isn't right." });
    }

    const problem = passwordProblems(newPassword, user.email);
    if (problem) {
      return response.status(400).json({ error: "validation_failed", message: problem.message, problems: [problem] });
    }

    await db
      .prepare(`UPDATE users SET password_hash = ?, password_changed_at = ${NOW_SQL} WHERE id = ?`)
      .run(await hashPassword(newPassword), user.id);

    // Every other device is signed out; this one keeps its session by getting a
    // brand new one after the revocation.
    await revokeAllSessions(user.id);
    await startSession(request, response, user);
    sendMail({ to: user.email, ...passwordChangedEmail() }).catch(() => {});

    console.log(`[auth] password changed for ${user.email}`);
    response.json({ ok: true });
  } catch (error) {
    console.error("[auth] change-password failed:", error);
    response.status(500).json({ error: "change_password_failed", message: error.message });
  }
});

// Where this account is signed in. One row per login, not per token: rotation
// would otherwise make a single browser look like hundreds of sessions.
app.get("/api/auth/sessions", requireUser, async (request, response) => {
  try {
    const cookies = parseCookies(request.headers.cookie);
    const current = cookies[REFRESH_COOKIE]
      ? await db.prepare("SELECT family_id FROM refresh_tokens WHERE token_hash = ?").get(hashRefreshToken(cookies[REFRESH_COOKIE]))
      : null;

    const rows = await db
      .prepare(
        `SELECT family_id,
                MIN(issued_at) AS started_at,
                MAX(COALESCE(last_used_at, issued_at)) AS last_used_at,
                MAX(user_agent) AS user_agent,
                MAX(ip) AS ip
         FROM refresh_tokens
         WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
         GROUP BY family_id
         ORDER BY MAX(COALESCE(last_used_at, issued_at)) DESC`
      )
      .all(request.user.id, utcNow());

    response.json({
      sessions: rows.map((row) => ({
        id: row.family_id,
        startedAt: row.started_at,
        lastUsedAt: row.last_used_at,
        device: row.user_agent || null,
        ip: row.ip || null,
        current: current ? row.family_id === current.family_id : false,
      })),
    });
  } catch (error) {
    console.error("[auth] sessions failed:", error);
    response.status(500).json({ error: "sessions_failed", message: error.message });
  }
});

app.delete("/api/auth/sessions", requireUser, requireCsrf, async (request, response) => {
  try {
    const cookies = parseCookies(request.headers.cookie);
    const current = cookies[REFRESH_COOKIE]
      ? await db.prepare("SELECT family_id FROM refresh_tokens WHERE token_hash = ?").get(hashRefreshToken(cookies[REFRESH_COOKIE]))
      : null;

    await revokeAllSessions(request.user.id, current?.family_id || null);

    // This device's access token was just invalidated along with the rest, so
    // hand it a new one rather than signing the customer out of the page they
    // are standing on.
    const user = await db.prepare("SELECT id, email FROM users WHERE id = ?").get(request.user.id);
    response.append(
      "Set-Cookie",
      serializeCookie(
        ACCESS_COOKIE,
        mintAccessToken(user),
        cookieAttributes({ secure: isSecureRequest(request), maxAgeSeconds: ACCESS_TOKEN_TTL_SECONDS })
      )
    );

    console.log(`[auth] signed out other devices for user ${request.user.id}`);
    response.json({ ok: true });
  } catch (error) {
    console.error("[auth] sign out everywhere failed:", error);
    response.status(500).json({ error: "sessions_failed", message: error.message });
  }
});

// ---------------------------------------------------------------------------
// Two-step verification
// ---------------------------------------------------------------------------
app.post("/api/auth/totp/setup", requireUser, requireCsrf, async (request, response) => {
  try {
    const user = await db.prepare("SELECT id, email, totp_enabled_at FROM users WHERE id = ?").get(request.user.id);
    if (user.totp_enabled_at) {
      return response.status(409).json({ error: "already_enabled", message: "Two-step verification is already on." });
    }

    // Stored but not yet active: it only counts once a code from the app proves
    // the secret actually made it there.
    const secret = createTotpSecret();
    await db.prepare("UPDATE users SET totp_secret = ? WHERE id = ?").run(secret, user.id);

    const url = otpauthUrl({ secret, account: user.email });
    response.json({ secret, otpauthUrl: url, qr: await QRCode.toDataURL(url, { margin: 1, width: 220 }) });
  } catch (error) {
    console.error("[auth] totp setup failed:", error);
    response.status(500).json({ error: "totp_setup_failed", message: error.message });
  }
});

app.post("/api/auth/totp/enable", requireUser, requireCsrf, async (request, response) => {
  try {
    const user = await db.prepare("SELECT id, email, totp_secret, totp_enabled_at FROM users WHERE id = ?").get(request.user.id);
    if (user.totp_enabled_at) {
      return response.status(409).json({ error: "already_enabled", message: "Two-step verification is already on." });
    }
    if (!user.totp_secret || !verifyTotp(user.totp_secret, request.body?.code)) {
      return response.status(400).json({ error: "invalid_code", message: "That code isn't right. Check your authenticator app." });
    }

    // Shown once, stored hashed — the same treatment as a password.
    const recoveryCodes = createRecoveryCodes(10);
    await db
      .prepare(`UPDATE users SET totp_enabled_at = ${NOW_SQL}, recovery_codes = ? WHERE id = ?`)
      .run(JSON.stringify(recoveryCodes.map(hashRecoveryCode)), user.id);

    sendMail({ to: user.email, ...twoFactorEnabledEmail(true) }).catch(() => {});
    console.log(`[auth] two-step verification enabled for ${user.email}`);
    response.json({ ok: true, recoveryCodes });
  } catch (error) {
    console.error("[auth] totp enable failed:", error);
    response.status(500).json({ error: "totp_enable_failed", message: error.message });
  }
});

// Turning it off needs the password: otherwise a borrowed, already-signed-in
// browser could quietly remove the second factor.
app.post("/api/auth/totp/disable", requireUser, requireCsrf, async (request, response) => {
  try {
    const user = await db.prepare("SELECT id, email, password_hash FROM users WHERE id = ?").get(request.user.id);
    if (!user || !(await verifyPassword(String(request.body?.password ?? ""), user.password_hash))) {
      return response.status(401).json({ error: "invalid_credentials", message: "Your password isn't right." });
    }

    await db.prepare("UPDATE users SET totp_secret = NULL, totp_enabled_at = NULL, recovery_codes = NULL WHERE id = ?").run(user.id);
    sendMail({ to: user.email, ...twoFactorEnabledEmail(false) }).catch(() => {});
    console.log(`[auth] two-step verification disabled for ${user.email}`);
    response.json({ ok: true });
  } catch (error) {
    console.error("[auth] totp disable failed:", error);
    response.status(500).json({ error: "totp_disable_failed", message: error.message });
  }
});

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------
app.get("/api/health", async (_request, response) => {
  try {
    await db.prepare("SELECT 1").get();
    response.json({ ok: true, database: "connected (postgres)", checkedAt: new Date().toISOString() });
  } catch (error) {
    response.status(503).json({ ok: false, database: "unavailable", message: error.message });
  }
});

// ---------------------------------------------------------------------------
// Admin inventory API — full internal detail (cost, reserved qty, notes, etc.)
// ---------------------------------------------------------------------------
app.get("/api/inventory", requireAdmin, async (request, response) => {
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

app.post("/api/inventory", requireAdmin, async (request, response) => {
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

app.get("/api/inventory/:id", requireAdmin, async (request, response) => {
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

app.put("/api/inventory/:id", requireAdmin, async (request, response) => {
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

app.delete("/api/inventory/:id", requireAdmin, async (request, response) => {
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

app.get("/api/facets", requireAdmin, async (request, response) => {
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

app.get("/api/dashboard", requireAdmin, async (_request, response) => {
  try {
    // GREATEST is Postgres's scalar equivalent of SQLite's two-argument MAX().
    const row = await db
      .prepare(
        `SELECT
          COALESCE(SUM(selling_price * quantity), 0) AS inventory_value,
          COALESCE(SUM(GREATEST(quantity - reserved_quantity, 0)), 0) AS stock_count,
          SUM(CASE WHEN GREATEST(quantity - reserved_quantity, 0) <= reorder_point THEN 1 ELSE 0 END) AS low_stock_count,
          COUNT(*) AS item_count
        FROM inventory_items
        WHERE deleted_at IS NULL`
      )
      .get();
    const searches = await db.prepare(`SELECT COUNT(*) AS count FROM search_events`).get();
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

app.get("/api/shop/products", async (request, response) => {
  const { q = "", category = "All", sort = "relevance" } = request.query;
  const minPrice = parseNumber(request.query.minPrice, 0);
  const maxPrice = parseNumber(request.query.maxPrice, 100000);
  const page = Math.max(1, Math.trunc(parseNumber(request.query.page, 1)));
  const pageSize = Math.min(Math.max(1, Math.trunc(parseNumber(request.query.pageSize, 24))), 100);
  const inStockOnly = request.query.inStockOnly === "true";

  const sellableStatuses = new Set(["Available", "Low Stock", "Reserved", "Out of Stock"]);

  try {
    let items = (await search({ q, category, warehouse: "All", status: "All", minPrice, maxPrice, sort, limit: 100000 })).filter(
      (item) => sellableStatuses.has(item.status)
    );
    if (inStockOnly) items = items.filter((item) => item.availableQuantity > 0);

    const total = items.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const currentPage = Math.min(page, totalPages);
    const start = (currentPage - 1) * pageSize;
    const pageItems = items.slice(start, start + pageSize);

    await recordSearchEvent(q, "shop", total);
    response.json({ items: pageItems.map(toShopItem), total, page: currentPage, pageSize, totalPages });
  } catch (error) {
    console.error("[shop] search failed:", error);
    response.status(500).json({ error: "shop_search_failed", message: error.message });
  }
});

app.get("/api/shop/suggest", async (request, response) => {
  const { q = "" } = request.query;
  const limit = Math.min(parseNumber(request.query.limit, 6), 10);

  if (!q.trim()) return response.json({ items: [] });

  const sellableStatuses = new Set(["Available", "Low Stock", "Reserved", "Out of Stock"]);
  try {
    const items = (await search({ q, warehouse: "All", status: "All", sort: "relevance", limit: 30 }))
      .filter((item) => sellableStatuses.has(item.status))
      .slice(0, limit)
      .map((item) => ({
        id: item.id,
        name: item.name,
        icon: item.icon,
        category: item.category ? item.category.split(">").map((part) => part.trim()).at(-1) : "",
      }));
    response.json({ items });
  } catch (error) {
    console.error("[shop] suggest failed:", error);
    response.status(500).json({ error: "suggest_failed", message: error.message });
  }
});

app.get("/api/shop/products/:id", async (request, response) => {
  try {
    const row = await db.prepare(`${baseSelect()} AND i.external_id = ?`).get(request.params.id);
    if (!row) {
      return response.status(404).json({ error: "not_found", message: "Product not found." });
    }
    row.tagsText = safeJsonArray(row.tags).join(" ");
    const item = toDomainItem(row);
    item.score = 50;
    response.json(toShopItem(item));
  } catch (error) {
    console.error(`[shop] product lookup failed for ${request.params.id}:`, error);
    response.status(500).json({ error: "product_lookup_failed", message: error.message });
  }
});

// Direct single-item order, bypassing the basket. The storefront buys through
// the basket now, but this stays for API callers — signed in, like any purchase.
app.post("/api/shop/orders", requireUser, requireCsrf, async (request, response) => {
  const { itemId } = request.body || {};
  if (!itemId) {
    return response.status(400).json({ error: "validation_failed", message: "Missing itemId." });
  }

  try {
    // Stock check, decrement, and order row all happen in one transaction, so
    // two shoppers racing for the last unit can't both take it and a failure
    // halfway through can't leave an order without the matching stock change.
    const result = await db.transaction(async (tx) => {
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
      await tx.prepare(
        `INSERT INTO orders (inventory_item_id, sku, name, brand, model, category, quantity, price, user_id)
         VALUES (?,?,?,?,?,?,?,?,?)`
      ).run(row.id, row.sku, row.name, row.brand, row.model, row.category_path, 1, row.selling_price, request.user.id);

      const updatedRow = await tx.prepare(`${baseSelect()} AND i.external_id = ?`).get(itemId);
      updatedRow.tagsText = safeJsonArray(updatedRow.tags).join(" ");
      const updatedItem = toDomainItem(updatedRow);
      updatedItem.score = 50;

      return { status: 201, body: { ok: true, item: toShopItem(updatedItem) } };
    });

    response.status(result.status).json(result.body);
  } catch (error) {
    console.error("[shop] order failed:", error);
    response.status(500).json({ error: "order_failed", message: error.message });
  }
});

app.get("/api/shop/facets", async (_request, response) => {
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
function toCents(value) {
  return Math.round((Number(value) || 0) * 100);
}

function fromCents(cents) {
  return cents / 100;
}

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
    const unitCents = toCents(row.selling_price);
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
      unitPrice: fromCents(unitCents),
      quantity: row.quantity,
      lineTotal: fromCents(lineCents),
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
    totals: [...totalsByCurrency].map(([currency, cents]) => ({ currency, subtotal: fromCents(cents) })),
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

app.get("/api/shop/cart", requireUser, async (request, response) => {
  try {
    response.json(await loadCart(request.user.id));
  } catch (error) {
    console.error("[cart] load failed:", error);
    response.status(500).json({ error: "cart_failed", message: error.message });
  }
});

// Clicking Buy on something already in the basket adds to that line instead of
// creating a second one — that's the UNIQUE (user_id, inventory_item_id) below.
app.post("/api/shop/cart", requireUser, requireCsrf, async (request, response) => {
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
app.patch("/api/shop/cart/:itemId", requireUser, requireCsrf, async (request, response) => {
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

app.delete("/api/shop/cart/:itemId", requireUser, requireCsrf, async (request, response) => {
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

app.delete("/api/shop/cart", requireUser, requireCsrf, async (request, response) => {
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
app.get("/api/shop/orders", requireUser, async (request, response) => {
  try {
    const rows = await db
      .prepare(
        `SELECT id, sku, name, brand, model, category, quantity, price, ordered_at AS "orderedAt"
         FROM orders
         WHERE user_id = ?
         ORDER BY ordered_at DESC, id DESC
         LIMIT 200`
      )
      .all(request.user.id);

    // Rows written in one checkout share a timestamp; grouping them turns the
    // list back into the orders the customer actually placed.
    const grouped = new Map();
    for (const row of rows) {
      const key = row.orderedAt;
      if (!grouped.has(key)) grouped.set(key, { placedAt: key, lines: [], total: 0, itemCount: 0 });
      const group = grouped.get(key);
      group.lines.push(row);
      group.total += toCents(row.price) * row.quantity;
      group.itemCount += row.quantity;
    }

    response.json({
      orders: [...grouped.values()].map((group) => ({ ...group, total: fromCents(group.total) })),
    });
  } catch (error) {
    console.error("[shop] order history failed:", error);
    response.status(500).json({ error: "orders_failed", message: error.message });
  }
});

// Checkout: the basket becomes orders and stock moves. All of it in one
// transaction with the stock rows locked, so two people checking out the last
// unit can't both get it, and a failure part-way can't leave an order without
// the matching stock change.
app.post("/api/shop/cart/checkout", requireUser, requireCsrf, async (request, response) => {
  try {
    const result = await db.transaction(async (tx) => {
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

      let totalCents = 0;
      for (const row of rows) {
        await tx
          .prepare(`UPDATE inventory_items SET quantity = quantity - ?, updated_at = ${NOW_SQL} WHERE id = ?`)
          .run(row.quantity, row.id);
        // price stays the unit price, matching every order row written before
        // baskets existed; quantity carries the rest.
        await tx
          .prepare(
            `INSERT INTO orders (inventory_item_id, sku, name, brand, model, category, quantity, price, user_id)
             VALUES (?,?,?,?,?,?,?,?,?)`
          )
          .run(row.id, row.sku, row.name, row.brand, row.model, row.category_path, row.quantity, row.selling_price, request.user.id);
        totalCents += toCents(row.selling_price) * row.quantity;
      }

      await tx.prepare("DELETE FROM cart_items WHERE user_id = ?").run(request.user.id);

      return {
        status: 201,
        body: {
          ok: true,
          orderCount: rows.length,
          itemCount: rows.reduce((sum, row) => sum + row.quantity, 0),
          total: fromCents(totalCents),
          currency: rows[0].currency || "USD",
        },
      };
    });

    if (result.status === 201) {
      console.log(`[cart] checkout by user ${request.user.id}: ${result.body.orderCount} lines`);
    }
    response.status(result.status).json(result.body);
  } catch (error) {
    console.error("[cart] checkout failed:", error);
    response.status(500).json({ error: "checkout_failed", message: error.message });
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
function tzOffsetMinutes(request) {
  const raw = Math.trunc(parseNumber(request.query.tzOffset, 0));
  return Math.max(-840, Math.min(840, raw)); // real-world offsets span -12:00..+14:00
}

// ordered_at is text, so it is cast to a timestamp before the offset is applied.
const LOCAL_ORDERED_AT = "ordered_at::timestamp + make_interval(mins => ?)";

app.get("/api/analytics/orders/summary", requireAdmin, async (request, response) => {
  const { month } = request.query;
  if (!MONTH_PATTERN.test(month || "")) {
    return response.status(400).json({ error: "validation_failed", message: "month must be YYYY-MM." });
  }

  try {
    const offset = tzOffsetMinutes(request);
    const rows = await db
      .prepare(
        `SELECT to_char(${LOCAL_ORDERED_AT}, 'YYYY-MM-DD') AS day, COUNT(*) AS count
         FROM orders
         WHERE to_char(${LOCAL_ORDERED_AT}, 'YYYY-MM') = ?
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

app.get("/api/analytics/orders/day", requireAdmin, async (request, response) => {
  const { date } = request.query;
  if (!DATE_PATTERN.test(date || "")) {
    return response.status(400).json({ error: "validation_failed", message: "date must be YYYY-MM-DD." });
  }

  try {
    const offset = tzOffsetMinutes(request);
    const rows = await db
      .prepare(
        `SELECT id, sku, name, brand, model, category, quantity, price, ordered_at AS "orderedAt"
         FROM orders
         WHERE to_char(${LOCAL_ORDERED_AT}, 'YYYY-MM-DD') = ?
         ORDER BY ordered_at DESC`
      )
      .all(offset, date);
    response.json({ orders: rows });
  } catch (error) {
    console.error("[analytics] order day lookup failed:", error);
    response.status(500).json({ error: "analytics_failed", message: error.message });
  }
});

// Last line of defence. Anything a route throws or rejects with lands here.
app.use((error, request, response, _next) => {
  console.error(`[error] ${request.method} ${request.originalUrl}:`, error);
  if (response.headersSent) return;
  response.status(500).json({ error: "server_error", message: "Something went wrong. Please try again." });
});

// A rejection with no handler at all (a background task, say) should be logged,
// never fatal.
process.on("unhandledRejection", (reason) => {
  console.error("[error] unhandled rejection:", reason);
});

const server = app.listen(port, () => {
  console.log(`PicsArt Shop running on http://localhost:${port}`);
  console.log(`  Storefront:     http://localhost:${port}/index.html`);
  console.log(`  Admin console:  http://localhost:${port}/admin.html`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => {
      db.close().finally(() => process.exit(0));
    });
  });
}
