// ---------------------------------------------------------------------------
// Cross-site request forgery
//
// Its own module because both halves of the app rely on it: the admin console
// and the customer API run the same check on every state-changing request.
// Keeping it here is what lets lib/admin-session.js enforce CSRF without
// reaching into the customer session code, and vice versa.
//
// Double-submit: a token is set in a cookie the page *can* read, and the page
// echoes it back in a header. Another origin can cause a request to be sent
// but cannot read our cookie, so it cannot produce the header.
// ---------------------------------------------------------------------------

import {
  createCsrfToken,
  csrfTokensMatch,
  CSRF_COOKIE,
  CSRF_HEADER,
  isSecureRequest,
  parseCookies,
  REFRESH_TOKEN_TTL_SECONDS,
} from "./auth.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Not HttpOnly on purpose: the page has to read it to echo it back. It is not a
// credential — it only proves the request came from our own page.
export function csrfCookie(token, { secure }) {
  return `${CSRF_COOKIE}=${encodeURIComponent(token)}; Path=/; SameSite=Strict${secure ? "; Secure" : ""}; Max-Age=${
    token ? REFRESH_TOKEN_TTL_SECONDS : 0
  }`;
}

// Every request gets a token, whether or not it is signed in: the login form
// itself is a state-changing request and needs one before any session exists.
export function ensureCsrfCookie(request, response, next) {
  const cookies = parseCookies(request.headers.cookie);
  request.csrfToken = cookies[CSRF_COOKIE];
  if (!request.csrfToken) {
    request.csrfToken = createCsrfToken();
    response.append("Set-Cookie", csrfCookie(request.csrfToken, { secure: isSecureRequest(request) }));
  }
  next();
}

// Double-submit check plus an origin check. SameSite=Strict already blocks the
// cross-site case; this is the layer that still holds if a browser ever fails
// to honour it.
export function requireCsrf(request, response, next) {
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
