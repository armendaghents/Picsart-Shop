import crypto from "node:crypto";

import {
  cookieAttributes,
  hashPassword,
  isSecureRequest,
  parseCookies,
  serializeCookie,
} from "./auth.js";
import { IS_PRODUCTION } from "./config.js";
import { requireCsrf } from "./csrf.js";

// ---------------------------------------------------------------------------
// Admin authentication
//
// The console can rewrite the catalogue and read every order, so it is held to
// a higher bar than a customer account. What each layer is for:
//
//   * ADMIN_IP_ALLOWLIST — when set, admin requests from anywhere else are
//     refused before authentication runs at all. Nothing else here matters to
//     someone who cannot reach the endpoint in the first place.
//   * The password is never held in memory in clear: ADMIN_PASSWORD_HASH holds
//     a scrypt hash, and a plain ADMIN_PASSWORD is hashed at boot and then
//     dropped from the environment.
//   * Online guessing — per-address and process-wide rate limits, plus a
//     lockout that doubles with each run of failures. Every attempt pays the
//     full scrypt cost, so a near miss and a wild guess take the same time.
//   * Password theft — with ADMIN_TOTP_SECRET set, a six-digit code from an
//     authenticator app is required too, so the password alone buys nothing.
//   * Session theft — the cookie is HttpOnly, SameSite=Strict and Secure off
//     localhost; the server keeps only a SHA-256 of the token; and each session
//     is pinned to the network and user agent that created it.
//   * CSRF — every unsafe admin request carries the same double-submit token
//     the customer API uses.
//   * Stale sessions — 30 minutes idle or 8 hours absolute, whichever comes
//     first, and the cookie itself dies with the browser.
//
// Run `node scripts/admin-credentials.mjs` to generate the hash and the
// authenticator secret.
// ---------------------------------------------------------------------------
export const SESSION_COOKIE = "atlas_session";
const ADMIN_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const ADMIN_ABSOLUTE_TIMEOUT_MS = 8 * 60 * 60 * 1000;

// Consecutive failures from one address before it is locked out, and how long
// that lockout lasts (doubling each further failure, up to the cap).
const ADMIN_LOCKOUT_AFTER = 5;
const ADMIN_LOCKOUT_BASE_MS = 60 * 1000;
const ADMIN_LOCKOUT_MAX_MS = 60 * 60 * 1000;

const sessions = new Map(); // sha256(token) -> { username, idleExpiresAt, absoluteExpiresAt, network, agent }
// Keyed by account *and* address, not by address alone. Two admins behind one
// office IP then can't lock each other out with their own typos, and nobody can
// lock a colleague out of the office by guessing their name from the outside.
const adminFailures = new Map(); // "username|ip" -> { count, lockedUntil }

// ---------------------------------------------------------------------------
// Admin accounts
//
// Two shapes, because a one-person shop and a two-person shop want different
// things:
//
//   ADMIN_USERS=anna,bob   named accounts. Each has its own password hash and
//                          its own authenticator secret, so the log says who
//                          signed in and removing one person leaves the other
//                          untouched:
//                            ADMIN_ANNA_PASSWORD_HASH=...
//                            ADMIN_ANNA_TOTP_SECRET=...
//
//   (unset)                the single shared login, from ADMIN_PASSWORD_HASH /
//                          ADMIN_PASSWORD / ADMIN_TOTP_SECRET. No username is
//                          asked for.
//
// Generate either with:  node scripts/admin-credentials.mjs --user anna
// ---------------------------------------------------------------------------
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/;

export function normalizeUsername(value) {
  return String(value ?? "").trim().toLowerCase();
}

// anna -> ADMIN_ANNA_..., first.last -> ADMIN_FIRST_LAST_...
function envKeyFor(username, suffix) {
  return `ADMIN_${username.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_${suffix}`;
}

const adminAccounts = new Map(); // username -> { username, passwordHash, totpSecret }

async function loadAdminAccount(username, { hashKey, passwordKey, totpKey, label }) {
  let passwordHash = (process.env[hashKey] || "").trim() || null;
  const plain = (process.env[passwordKey] || "").trim();

  if (!passwordHash) {
    if (IS_PRODUCTION && (!plain || plain === "changeme")) {
      console.error(
        `FATAL: ${label} has no credentials. Set ${hashKey} (preferred) or a real ${passwordKey} ` +
          `before running with NODE_ENV=production.\n       Generate one with:  node scripts/admin-credentials.mjs`
      );
      process.exit(1);
    }
    if (!plain) {
      console.warn(
        `WARNING: ${passwordKey} is not set — ${label} falls back to the development password 'changeme'. ` +
          "The server refuses to start this way when NODE_ENV=production."
      );
    }
    // Derive the hash once, then forget the clear password: from here on a heap
    // dump or a stray console.log(process.env) gives up nothing usable.
    passwordHash = await hashPassword(plain || "changeme");
  }
  delete process.env[passwordKey];

  const totpSecret = (process.env[totpKey] || "").trim() || null;
  if (IS_PRODUCTION && !totpSecret) {
    console.warn(
      `WARNING: ${totpKey} is not set — ${label} is guarded by a password alone. ` +
        "Run `node scripts/admin-credentials.mjs` to enrol an authenticator app."
    );
  }
  adminAccounts.set(username, { username, passwordHash, totpSecret });
}

const declaredAdmins = (process.env.ADMIN_USERS || "")
  .split(",")
  .map(normalizeUsername)
  .filter(Boolean);

// With no ADMIN_USERS the console keeps its single unnamed login, so an
// existing .env and the login form both carry on working unchanged.
export const ADMIN_SINGLE_USER = "admin";
export const ADMIN_NAMED_ACCOUNTS = declaredAdmins.length > 0;

if (ADMIN_NAMED_ACCOUNTS) {
  for (const username of declaredAdmins) {
    if (!USERNAME_PATTERN.test(username)) {
      console.error(
        `FATAL: "${username}" in ADMIN_USERS is not a usable name. Use letters, digits, dot, dash or ` +
          "underscore, starting with a letter or digit, at most 32 characters."
      );
      process.exit(1);
    }
    if (adminAccounts.has(username)) continue;
    await loadAdminAccount(username, {
      hashKey: envKeyFor(username, "PASSWORD_HASH"),
      passwordKey: envKeyFor(username, "PASSWORD"),
      totpKey: envKeyFor(username, "TOTP_SECRET"),
      label: `admin '${username}'`,
    });
  }
  console.log(`[auth] admin accounts: ${[...adminAccounts.keys()].join(", ")}`);
} else {
  await loadAdminAccount(ADMIN_SINGLE_USER, {
    hashKey: "ADMIN_PASSWORD_HASH",
    passwordKey: "ADMIN_PASSWORD",
    totpKey: "ADMIN_TOTP_SECRET",
    label: "the admin console",
  });
}

// Someone submitting an unknown username must wait exactly as long, and be told
// exactly as little, as someone submitting a real one with the wrong password.
// Verifying against this throwaway hash costs the same scrypt work as the real
// thing, so the response time never says which usernames exist.
export const DECOY_PASSWORD_HASH = await hashPassword(crypto.randomBytes(32).toString("hex"));

export function lookupAdminAccount(submitted) {
  if (!ADMIN_NAMED_ACCOUNTS) return adminAccounts.get(ADMIN_SINGLE_USER);
  return adminAccounts.get(normalizeUsername(submitted)) || null;
}

// The login form only needs to know whether to draw the code box; which
// accounts exist is not something it is told.
export const ADMIN_TOTP_IN_USE = [...adminAccounts.values()].some((account) => account.totpSecret);

// ---------------------------------------------------------------------------
// Where an admin request is allowed to come from
// ---------------------------------------------------------------------------
const ADMIN_IP_ALLOWLIST = (process.env.ADMIN_IP_ALLOWLIST || "")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);

// Express reports an IPv4 client as ::ffff:1.2.3.4 when the socket is IPv6.
export function normalizeIp(value) {
  const ip = String(value || "");
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

// Pinning a session to an exact address looks stronger than it is: one machine
// legitimately changes address all the time. `localhost` resolves to both ::1
// and 127.0.0.1, and a browser will use either from one connection to the next
// — so an exact pin drops the session halfway through loading the console.
// Wi-Fi to LTE, or any proxy with several egress addresses, does the same in
// production.
//
// So the pin is to the surrounding network instead: a /24 for IPv4, a /64 for
// IPv6, and all loopback addresses treated as one. A cookie exfiltrated to some
// other network is still refused, which is the case worth catching, while an
// admin who stays where they are keeps their session.
//
// Set ADMIN_PIN_SESSION_NETWORK=off to pin on the user agent alone.
const PIN_SESSION_NETWORK = (process.env.ADMIN_PIN_SESSION_NETWORK || "on").toLowerCase() !== "off";

function sessionNetwork(request) {
  if (!PIN_SESSION_NETWORK) return "any";
  const ip = normalizeIp(request.ip);
  if (ip === "::1" || ip === "" || /^127\./.test(ip)) return "loopback";
  if (ip.includes(":")) return ip.split(":").slice(0, 4).join(":"); // /64
  const octets = ip.split(".");
  return octets.length === 4 ? octets.slice(0, 3).join(".") : ip; // /24
}

function ipv4ToInt(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

// Exact addresses of either family, plus IPv4 CIDR ranges — enough to say "the
// office" or "the VPN" without taking on a dependency.
function ipMatchesRule(ip, rule) {
  if (!rule.includes("/")) return ip === normalizeIp(rule);
  const [network, bitsText] = rule.split("/");
  const bits = Number(bitsText);
  const networkInt = ipv4ToInt(normalizeIp(network));
  const ipInt = ipv4ToInt(ip);
  if (networkInt === null || ipInt === null) return false;
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return ((ipInt & mask) >>> 0) === ((networkInt & mask) >>> 0);
}

function adminNetworkAllowed(request) {
  if (!ADMIN_IP_ALLOWLIST.length) return true;
  const ip = normalizeIp(request.ip);
  return ADMIN_IP_ALLOWLIST.some((rule) => ipMatchesRule(ip, rule));
}

// 404 rather than 403: an address that is not allowed learns nothing, not even
// that there is a console here to attack.
export function requireAdminNetwork(request, response, next) {
  if (adminNetworkAllowed(request)) return next();
  console.warn(
    `[admin] blocked ${request.method} ${request.originalUrl} from ${normalizeIp(request.ip)} — not in ADMIN_IP_ALLOWLIST`
  );
  return response.status(404).type("text/plain").send("Not found");
}

// ---------------------------------------------------------------------------
// Failed-attempt lockout
// ---------------------------------------------------------------------------
// An unknown username is folded into one bucket per address, so someone
// submitting random names cannot grow this map without bound.
export function adminFailureKey(username, ip) {
  return `${username || "?"}|${ip}`;
}

export function adminLockRemainingMs(key) {
  const record = adminFailures.get(key);
  return record ? Math.max(0, record.lockedUntil - Date.now()) : 0;
}

// Wipes the run of failures for an account+address. Called on a successful
// sign-in, so a lockout only ever counts *consecutive* failures — a correct
// password clears the slate rather than leaving the next typo closer to a lock.
export function clearAdminFailures(key) {
  adminFailures.delete(key);
}

export function recordAdminFailure(key) {
  const record = adminFailures.get(key) || { count: 0, lockedUntil: 0 };
  record.count += 1;
  if (record.count >= ADMIN_LOCKOUT_AFTER) {
    const overshoot = record.count - ADMIN_LOCKOUT_AFTER;
    record.lockedUntil = Date.now() + Math.min(ADMIN_LOCKOUT_BASE_MS * 2 ** overshoot, ADMIN_LOCKOUT_MAX_MS);
  }
  adminFailures.set(key, record);
  return record;
}

// ---------------------------------------------------------------------------
// Cookies and sessions
// ---------------------------------------------------------------------------
function hashSessionToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function agentFingerprint(request) {
  return crypto.createHash("sha256").update(String(request.headers["user-agent"] || "")).digest("hex");
}

// Retires the session a request is holding, by token. Used on sign-out, and on
// sign-in to drop whatever the browser had before — a session fixated ahead of
// login is then worth nothing. Returns what was there, so the caller can log
// who it belonged to.
export function destroyAdminSession(token) {
  if (!token) return null;
  const key = hashSessionToken(token);
  const session = sessions.get(key) || null;
  sessions.delete(key);
  return session;
}

export function createAdminSession(request, username) {
  const token = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  // Only the hash is stored. The value in the cookie never touches this map,
  // so a heap dump or a leaked log line cannot be replayed as a session.
  sessions.set(hashSessionToken(token), {
    username,
    idleExpiresAt: now + ADMIN_IDLE_TIMEOUT_MS,
    absoluteExpiresAt: now + ADMIN_ABSOLUTE_TIMEOUT_MS,
    network: sessionNetwork(request),
    agent: agentFingerprint(request),
  });
  return token;
}

// Returns the live session and slides the idle window forward, or null.
// A pin mismatch deletes the session outright instead of just refusing this one
// request: a cookie arriving from somewhere else means the real one is already
// in the wrong hands.
export function readAdminSession(request) {
  const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
  if (!token) return null;
  const key = hashSessionToken(token);
  const session = sessions.get(key);
  if (!session) return null;

  const now = Date.now();
  if (now > session.idleExpiresAt || now > session.absoluteExpiresAt) {
    sessions.delete(key);
    return null;
  }
  if (session.network !== sessionNetwork(request) || session.agent !== agentFingerprint(request)) {
    console.warn(
      `[admin] session cookie presented from ${normalizeIp(request.ip)} (network ${sessionNetwork(request)}) ` +
        `but was issued to network ${session.network} — session destroyed`
    );
    sessions.delete(key);
    return null;
  }
  session.idleExpiresAt = Math.min(now + ADMIN_IDLE_TIMEOUT_MS, session.absoluteExpiresAt);
  return session;
}

export function isAuthed(request) {
  return readAdminSession(request) !== null;
}

// The whole gate for an admin route: right network, live session, and — for
// anything that changes state — a matching CSRF token.
export function requireAdmin(request, response, next) {
  if (!adminNetworkAllowed(request)) {
    return response.status(404).json({ error: "not_found" });
  }
  const session = readAdminSession(request);
  if (!session) {
    return response.status(401).json({ error: "unauthorized", message: "Admin login required." });
  }
  // Read back by the access log, so every admin request records who made it.
  request.admin = { username: session.username };
  return requireCsrf(request, response, next);
}

// Expired entries are dropped on access, but a session that is never touched
// again would otherwise sit in the map for the life of the process.
setInterval(() => {
  const now = Date.now();
  for (const [key, session] of sessions) {
    if (now > session.idleExpiresAt || now > session.absoluteExpiresAt) sessions.delete(key);
  }
  for (const [key, record] of adminFailures) {
    if (now > record.lockedUntil + ADMIN_LOCKOUT_MAX_MS) adminFailures.delete(key);
  }
}, 5 * 60 * 1000).unref();

export function setSessionCookie(response, request, token) {
  response.append(
    "Set-Cookie",
    serializeCookie(
      SESSION_COOKIE,
      token,
      // persistent: false omits Max-Age, so the cookie dies with the browser.
      // The server-side idle timeout is the real clock either way.
      cookieAttributes({ secure: isSecureRequest(request), persistent: false, sameSite: "Strict" })
    )
  );
}

export function clearSessionCookie(response, request) {
  response.append(
    "Set-Cookie",
    serializeCookie(
      SESSION_COOKIE,
      "",
      cookieAttributes({ secure: isSecureRequest(request), maxAgeSeconds: 0, sameSite: "Strict" })
    )
  );
}
