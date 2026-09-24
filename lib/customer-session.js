// ---------------------------------------------------------------------------
// Storefront customer sessions
//
// The customer half of authentication: the signed access token, the cookies it
// travels in, the revocation epoch behind "sign out everywhere", and the
// throttle that keeps the credential endpoints from being guessable.
//
// Separate from lib/admin-session.js on purpose — the two are different
// mechanisms with different lifetimes, and sharing a file is how they end up
// sharing rules they should not.
// ---------------------------------------------------------------------------

import crypto from "node:crypto";

import {
  ACCESS_COOKIE,
  ACCESS_TOKEN_TTL_SECONDS,
  CHALLENGE_COOKIE,
  cookieAttributes,
  isSecureRequest,
  parseCookies,
  REFRESH_COOKIE,
  REFRESH_COOKIE_PATH,
  REFRESH_TOKEN_TTL_SECONDS,
  serializeCookie,
  signAccessToken,
  verifyAccessToken,
} from "./auth.js";
import { csrfCookie } from "./csrf.js";
import { db } from "../db/connection.js";

export const AUTH_SECRET = process.env.AUTH_SECRET || crypto.randomBytes(32).toString("hex");

if (!process.env.AUTH_SECRET) {
  console.warn(
    "WARNING: AUTH_SECRET is not set in .env — a random one was generated, so every customer is signed out when the server restarts. Set a real one before deploying."
  );
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function issueCookies(response, request, { accessToken, refreshToken, csrfToken }) {
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
    cookies.push(csrfCookie(csrfToken, { secure }));
  }

  for (const cookie of cookies) response.append("Set-Cookie", cookie);
}

export function clearAuthCookies(response, request) {
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
export async function invalidateAccessTokens(userId) {
  const epoch = Date.now();
  sessionEpochs.set(userId, epoch);
  await db.prepare("UPDATE users SET sessions_valid_from = ? WHERE id = ?").run(epoch, userId);
  return epoch;
}

export function mintAccessToken(user) {
  return signAccessToken({ sub: user.id, email: user.email, ms: Date.now() }, AUTH_SECRET);
}

// Reads the access token, if there is a valid one. Never rejects: routes decide
// for themselves whether a signed-in customer is required.
export function attachUser(request, _response, next) {
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
export function requireUser(request, response, next) {
  if (request.user) return next();
  return response.status(401).json({ error: "auth_required", message: "Please sign in to continue." });
}

// Small in-memory throttle for the credential endpoints. Enough to make online
// password guessing impractical on a single-instance deployment.
const attemptBuckets = new Map(); // key -> { count, resetAt }

export function rateLimit(key, limit, windowMs) {
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
