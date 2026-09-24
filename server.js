// ---------------------------------------------------------------------------
// Picsart Shop — the server
//
// This file assembles the app and nothing else: middleware, then the route
// modules in the order they must match, then the error handler. The routes
// themselves live in routes/, and the machinery they use in lib/.
// ---------------------------------------------------------------------------

import "dotenv/config";
import cors from "cors";
import crypto from "node:crypto";
import express from "express";
import helmet from "helmet";

import { db } from "./db/connection.js";
import { PORT, PUBLIC_DIR, TRUST_PROXY } from "./lib/config.js";
import { withAsyncErrors } from "./lib/async-routes.js";
import { ensureCsrfCookie } from "./lib/csrf.js";
import { attachUser } from "./lib/customer-session.js";
import { startSnapshotSchedule } from "./lib/snapshots.js";

import adminAuthRoutes from "./routes/admin-auth.js";
import adminInventoryRoutes from "./routes/admin-inventory.js";
import adminOrderRoutes from "./routes/admin-orders.js";
import analyticsRoutes from "./routes/analytics.js";
import authRoutes from "./routes/auth.js";
import cartRoutes from "./routes/cart.js";
import shopRoutes from "./routes/shop.js";

const app = express();

// Behind a reverse proxy every request arrives from the proxy, so request.ip is
// the proxy's address and X-Forwarded-For is whatever the client sent — which
// would make the rate limits, the lockout and the admin IP allowlist both
// useless and trivially spoofable. Set TRUST_PROXY to the number of proxies in
// front of this server (usually 1) so Express takes the right hop, and leave it
// unset when nothing is in front.
if (TRUST_PROXY) {
  app.set("trust proxy", /^\d+$/.test(TRUST_PROXY) ? Number(TRUST_PROXY) : TRUST_PROXY);
}
// Don't advertise what we are running.
app.disable("x-powered-by");

withAsyncErrors(app);

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
    // Admin requests carry the account that made them, so the log answers
    // "who changed this?" and not merely "something changed".
    const who = request.admin ? ` [admin ${request.admin.username}]` : "";
    console.log(`${request.method} ${request.originalUrl} ${response.statusCode} ${ms}ms${who}`);
  });
  next();
});

// ---------------------------------------------------------------------------
// Routes
//
// Order matters in two places. The admin console mounts before the static
// handler, so /admin is gated rather than served as a file; and every /api
// route mounts before it too, so nothing under public/ can shadow one.
// ---------------------------------------------------------------------------

// Signing in to the console, and serving the console itself.
app.use(adminAuthRoutes);

app.use(express.static(PUBLIC_DIR));

// Customer accounts: register, sign in, sessions, two-step verification.
app.use("/api/auth", authRoutes);

// Is the process up and can it reach the database? Deliberately unauthenticated
// and deliberately cheap: a load balancer polls it constantly.
app.get("/api/health", async (_request, response) => {
  try {
    await db.prepare("SELECT 1").get();
    response.json({ ok: true, database: "connected (postgres)", checkedAt: new Date().toISOString() });
  } catch (error) {
    response.status(503).json({ ok: false, database: "unavailable", message: error.message });
  }
});

app.use(adminInventoryRoutes); // the catalogue, from the inside
app.use(shopRoutes); //           the catalogue, as a customer sees it
app.use(cartRoutes); //           basket, checkout, a customer's own orders
app.use(adminOrderRoutes); //     fulfilment
app.use(analyticsRoutes); //      the order calendar

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

await startSnapshotSchedule();

const server = app.listen(PORT, () => {
  console.log(`PicsArt Shop running on http://localhost:${PORT}`);
  console.log(`  Storefront:     http://localhost:${PORT}/index.html`);
  console.log(`  Admin console:  http://localhost:${PORT}/admin.html`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => {
      db.close().finally(() => process.exit(0));
    });
  });
}
