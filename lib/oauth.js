// Sign in with Google — OAuth 2.0 authorization code flow.
//
// Redirect-based on purpose. No Google JavaScript runs in the page, so the
// strict Content-Security-Policy stays as it is and no third-party script is
// ever in a position to read the session cookies. The browser only ever carries
// an opaque code; the exchange for an identity happens server to server.
//
// What this buys the shop: a Google account proves the address belongs to the
// person signing in, so an account created this way needs no emailed
// verification code and has no password to reset — the two flows that otherwise
// make a working mail server a hard requirement.

import crypto from "node:crypto";

const AUTHORIZE_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const VALID_ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

// The button is only offered when both halves are present, so a deployment that
// hasn't set this up simply shows the email/password form.
export const googleIsConfigured = Boolean(CLIENT_ID && CLIENT_SECRET);

export const STATE_COOKIE = "atlas_oauth_state";
export const STATE_TTL_SECONDS = 10 * 60;

// Google matches this against the Authorised redirect URI in the Cloud console
// character for character. PUBLIC_URL is what a deployment should set; falling
// back to the request's own host keeps local development working with no config
// beyond the client id and secret.
export function callbackUrl(request, publicUrl = process.env.PUBLIC_URL) {
  const base = publicUrl ? publicUrl.replace(/\/+$/, "") : `${request.protocol}://${request.get("host")}`;
  return `${base}/api/auth/google/callback`;
}

// Tying the callback to the browser that started the flow: the value is held in
// a short-lived cookie and must come back unchanged, so a link that someone else
// crafted can't complete a sign-in in this browser (CSRF on the callback).
export function createState() {
  return crypto.randomBytes(24).toString("base64url");
}

export function statesMatch(cookieValue, queryValue) {
  const a = Buffer.from(String(cookieValue ?? ""));
  const b = Buffer.from(String(queryValue ?? ""));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function authorizationUrl({ state, redirectUri, loginHint }) {
  const url = new URL(AUTHORIZE_ENDPOINT);
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  // No refresh token is wanted: this is an identity check at sign-in, not
  // ongoing access to anything of theirs.
  url.searchParams.set("access_type", "online");
  if (loginHint) url.searchParams.set("login_hint", loginHint);
  return url.toString();
}

// The payload of an id_token. Safe to read without checking the signature here
// *because of where it came from*: it is the direct, TLS-protected response to a
// request we made to Google's token endpoint authenticated with our own client
// secret, so it cannot have been substituted in transit. (An id_token arriving
// any other way — from the browser, say — would have to be verified against
// Google's public keys.) The claims below are still checked, since they say who
// the token was minted for.
function decodeIdToken(idToken) {
  const [, payload] = String(idToken ?? "").split(".");
  if (!payload) throw new Error("id_token was not a JWT");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

export async function exchangeCodeForProfile({ code, redirectUri }) {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`token exchange failed (${response.status}): ${detail.slice(0, 200)}`);
  }

  const claims = decodeIdToken((await response.json()).id_token);

  if (!VALID_ISSUERS.has(claims.iss)) throw new Error(`unexpected issuer ${claims.iss}`);
  if (claims.aud !== CLIENT_ID) throw new Error("id_token was minted for a different client");
  if (Number(claims.exp) * 1000 <= Date.now()) throw new Error("id_token has expired");
  if (!claims.email) throw new Error("id_token carried no email address");
  // Google sets this false for addresses it hasn't confirmed itself, which
  // would defeat the whole point of trusting the address without our own code.
  if (claims.email_verified !== true && claims.email_verified !== "true") {
    throw new Error("Google has not verified this address");
  }

  return {
    // Stable per (account, client) and never reused, unlike an email address,
    // which a person can change.
    googleId: String(claims.sub),
    email: String(claims.email),
    name: claims.name ? String(claims.name) : null,
  };
}
