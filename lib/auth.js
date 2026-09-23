// Storefront customer authentication primitives: password hashing, the signed
// access token, and opaque refresh tokens.
//
// The threat model this is built against:
//
//   * Password database disclosure — passwords are scrypt-hashed with a random
//     per-user salt, so the table is useless without an expensive brute force.
//   * Refresh token database disclosure — only a SHA-256 of each refresh token
//     is stored. The value in the cookie never touches the database.
//   * XSS — no token is readable from JavaScript. Both are HttpOnly cookies.
//   * CSRF — cookies are SameSite=Strict, and unsafe requests additionally
//     carry a double-submit token (see the csrf helpers below).
//   * Token theft — access tokens expire in 15 minutes; refresh tokens rotate
//     on every use, and replaying a used one kills the whole session family.

import crypto from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(crypto.scrypt);

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60; // 15 minutes
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

export const ACCESS_COOKIE = "atlas_access";
export const REFRESH_COOKIE = "atlas_refresh";
// Held between "password accepted" and "two-step code accepted". On its own it
// authenticates nothing — it only says which account is part-way through.
export const CHALLENGE_COOKIE = "atlas_2fa";
export const CHALLENGE_TTL_SECONDS = 10 * 60;
export const CSRF_COOKIE = "atlas_csrf";
export const CSRF_HEADER = "x-csrf-token";

// The refresh cookie is scoped to the one endpoint that consumes it, so it is
// not attached to ordinary API calls and cannot leak through them.
export const REFRESH_COOKIE_PATH = "/api/auth/refresh";

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------
const SCRYPT_N = 16384;
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const SCRYPT_KEYLEN = 64;

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p });
  return ["scrypt", SCRYPT_N, SCRYPT_r, SCRYPT_p, salt.toString("base64"), derived.toString("base64")].join("$");
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, salt, expected] = parts;
  const expectedBuffer = Buffer.from(expected, "base64");
  let derived;
  try {
    derived = await scrypt(password, Buffer.from(salt, "base64"), expectedBuffer.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    });
  } catch {
    return false;
  }
  return derived.length === expectedBuffer.length && crypto.timingSafeEqual(derived, expectedBuffer);
}

// ---------------------------------------------------------------------------
// Access token — a compact HS256 JWT, verified on every request without a
// database round trip. Kept short-lived precisely because it is not revocable.
// ---------------------------------------------------------------------------
function encodeSegment(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function sign(data, secret) {
  return crypto.createHmac("sha256", secret).update(data).digest("base64url");
}

// Every token carries a `use` claim naming what it is allowed to do. A real
// session token is "access"; the short-lived cookie that only says "password
// accepted, second factor still pending" is "2fa-challenge". They are signed
// with the same key, so without this claim one is indistinguishable from the
// other — and the pending-2FA token would be usable as a full session, which
// is exactly the 2FA bypass this guards against. verifyAccessToken() rejects a
// token whose `use` isn't the one the caller expects.
export const TOKEN_USE_ACCESS = "access";
export const TOKEN_USE_CHALLENGE = "2fa-challenge";

export function signAccessToken(payload, secret, ttlSeconds = ACCESS_TOKEN_TTL_SECONDS) {
  const issuedAt = Math.floor(Date.now() / 1000);
  // Default to an access token; a caller minting a different kind (the 2FA
  // challenge) overrides `use` through the payload.
  const body = { use: TOKEN_USE_ACCESS, ...payload, iat: issuedAt, exp: issuedAt + ttlSeconds };
  const data = `${encodeSegment({ alg: "HS256", typ: "JWT" })}.${encodeSegment(body)}`;
  return `${data}.${sign(data, secret)}`;
}

export function verifyAccessToken(token, secret, expectedUse = TOKEN_USE_ACCESS) {
  if (typeof token !== "string") return null;
  const segments = token.split(".");
  if (segments.length !== 3) return null;

  const data = `${segments[0]}.${segments[1]}`;
  const expected = Buffer.from(sign(data, secret), "utf8");
  const actual = Buffer.from(segments[2], "utf8");
  // Length check first: timingSafeEqual throws on a mismatch rather than
  // returning false, and a wrong length is not a secret worth protecting.
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload?.exp !== "number" || payload.exp <= Math.floor(Date.now() / 1000)) return null;
  // A token is only accepted for the exact purpose it was minted for. A missing
  // claim (a token from before this check existed) never matches, so it is
  // rejected and the client silently re-mints one through /api/auth/refresh.
  if (payload.use !== expectedUse) return null;
  return payload;
}

// ---------------------------------------------------------------------------
// Refresh token — opaque randomness. The browser holds the value; the database
// holds only its hash.
// ---------------------------------------------------------------------------
export function createRefreshToken() {
  return crypto.randomBytes(32).toString("base64url");
}

export function hashRefreshToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

export function createFamilyId() {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// CSRF — double submit. The token is readable by our own JavaScript (so it can
// be echoed in a header) but a cross-origin page can neither read the cookie
// nor set the header, so it cannot forge a state-changing request.
// ---------------------------------------------------------------------------
export function createCsrfToken() {
  return crypto.randomBytes(24).toString("base64url");
}

export function csrfTokensMatch(cookieValue, headerValue) {
  if (typeof cookieValue !== "string" || typeof headerValue !== "string") return false;
  if (!cookieValue || cookieValue.length !== headerValue.length) return false;
  return crypto.timingSafeEqual(Buffer.from(cookieValue, "utf8"), Buffer.from(headerValue, "utf8"));
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 200; // scrypt cost is paid by the server; don't let a request choose it
export const MAX_NAME_LENGTH = 100;


export function normalizeEmail(value) {
  return String(value ?? "").trim().toLowerCase();
}

// Not a substitute for rate limiting, but it stops the passwords that appear at
// the top of every breach list from being chosen in the first place.
const COMMON_PASSWORDS = new Set([
  "password", "password1", "password123", "12345678", "123456789", "1234567890",
  "qwerty123", "qwertyuiop", "letmein1", "welcome1", "admin123", "iloveyou",
  "sunshine1", "princess1", "football1", "monkey123", "abc12345", "passw0rd",
  "trustno1", "dragon123", "baseball1", "superman1", "michael1", "shadow123",
]);

// Each problem carries a stable `code` (plus any numbers it mentions) next to
// the English `message`, so the storefront — which runs in three languages —
// can word it itself instead of relaying whatever the API happened to say.
export function passwordProblems(password, email) {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    return {
      code: "password_too_short",
      params: { min: MIN_PASSWORD_LENGTH },
      message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    };
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return {
      code: "password_too_long",
      params: { max: MAX_PASSWORD_LENGTH },
      message: `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`,
    };
  }
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    return {
      code: "password_common",
      message: "That password is one of the most commonly used ones. Please choose another.",
    };
  }
  const normalizedEmail = normalizeEmail(email);
  if (normalizedEmail && password.toLowerCase() === normalizedEmail) {
    return { code: "password_is_email", message: "Your password can't be your email address." };
  }
  if (normalizedEmail && password.toLowerCase() === normalizedEmail.split("@")[0]) {
    return { code: "password_in_email", message: "Your password can't be part of your email address." };
  }
  return null;
}

export function validateCredentials({ email, password, name }) {
  const errors = [];
  if (!EMAIL_PATTERN.test(normalizeEmail(email))) {
    errors.push({ code: "email_invalid", message: "Enter a valid email address." });
  }
  const passwordProblem = passwordProblems(password, email);
  if (passwordProblem) errors.push(passwordProblem);
  if (name !== undefined && name !== null && String(name).length > MAX_NAME_LENGTH) {
    errors.push({
      code: "name_too_long",
      params: { max: MAX_NAME_LENGTH },
      message: `Name must be at most ${MAX_NAME_LENGTH} characters.`,
    });
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------
// Secure is set whenever the app is not being served over plain localhost, so
// development works without TLS while a deployed instance never sends a token
// over http.
// `persistent: false` omits Max-Age, which makes it a session cookie — the
// browser drops it when it closes. That is what "keep me signed in" unchecked
// means: the session survives page loads but not the browser.
// sameSite defaults to Strict, which is what every session cookie here wants.
// The one exception is the OAuth state cookie: the browser returns from
// accounts.google.com by a top-level cross-site navigation, and a Strict cookie
// is deliberately withheld on exactly that request — so the state could never be
// compared and every sign-in would fail. Lax still blocks the cross-site POSTs
// that SameSite exists to stop.
export function cookieAttributes({ secure, maxAgeSeconds, path = "/", persistent = true, sameSite = "Strict" }) {
  return [
    `Path=${path}`,
    "HttpOnly",
    `SameSite=${sameSite}`,
    secure ? "Secure" : null,
    persistent || maxAgeSeconds === 0 ? `Max-Age=${maxAgeSeconds}` : null,
  ]
    .filter(Boolean)
    .join("; ");
}

export function serializeCookie(name, value, attributes) {
  return `${name}=${encodeURIComponent(value)}; ${attributes}`;
}
