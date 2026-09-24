// Storefront API client.
//
// Two things happen here that the rest of the app doesn't have to think about:
//
//   * CSRF — every state-changing request echoes the atlas_csrf cookie back in
//     a header. That cookie is the only one our JavaScript can read; the tokens
//     that actually authenticate the request are HttpOnly and invisible here.
//   * Token refresh — the access token lasts 15 minutes. When a request comes
//     back 401, the client silently rotates the refresh token and replays the
//     request once, so a session lasting weeks never interrupts the customer.

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// A 401 from these is an answer about credentials — "wrong password", "bad
// code" — not a session that quietly aged out, so replaying them after a
// refresh would be wrong (and /refresh itself would recurse).
//
// Everything else under /api/auth is ordinary account management behind a
// session: turning on two-step verification, changing a name, listing devices.
// Those must retry like any other call. Excluding the whole prefix, as this
// once did, meant that once the 15-minute access token expired, every button
// in the account panel failed and only failed — the page had been open longer
// than the token lived.
const CREDENTIAL_PATHS = new Set([
  "/api/auth/lookup",
  "/api/auth/register",
  "/api/auth/verify-email",
  "/api/auth/resend-code",
  "/api/auth/login",
  "/api/auth/two-factor",
  "/api/auth/forgot-password",
  "/api/auth/reset-password",
  "/api/auth/refresh",
]);

function readCookie(name) {
  const prefix = `${name}=`;
  const match = document.cookie.split("; ").find((entry) => entry.startsWith(prefix));
  return match ? decodeURIComponent(match.slice(prefix.length)) : "";
}

async function ensureCsrfToken() {
  const existing = readCookie("atlas_csrf");
  if (existing) return existing;
  await fetch("/api/auth/csrf", { credentials: "same-origin" });
  return readCookie("atlas_csrf");
}

// One refresh at a time: if several requests expire together they all wait on
// the same rotation instead of racing, which would trip reuse detection.
let refreshInFlight = null;

async function refreshSession() {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        const response = await fetch("/api/auth/refresh", {
          method: "POST",
          credentials: "same-origin",
          headers: { "X-CSRF-Token": await ensureCsrfToken() },
        });
        if (!response.ok) return null;
        const data = await response.json().catch(() => ({}));
        return data.user || null;
      } catch {
        return null;
      } finally {
        // Cleared on the next tick so concurrent callers share this result.
        setTimeout(() => {
          refreshInFlight = null;
        }, 0);
      }
    })();
  }
  return refreshInFlight;
}

// Exported so the rule can be asserted directly. It is the kind of decision
// that looks obvious and is easy to get subtly wrong — the previous version
// excluded the whole /api/auth prefix and silently broke every account-panel
// action once the access token aged out.
export function shouldRetryAfterRefresh(path) {
  return !CREDENTIAL_PATHS.has(path.split("?")[0]);
}

async function request(path, { method = "GET", body, allowRetry = true } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (!SAFE_METHODS.has(method)) headers["X-CSRF-Token"] = await ensureCsrfToken();

  const response = await fetch(path, {
    method,
    headers,
    credentials: "same-origin",
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (response.status === 401 && allowRetry && shouldRetryAfterRefresh(path)) {
    const user = await refreshSession();
    if (user) return request(path, { method, body, allowRetry: false });
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || `Request failed: ${response.status}`);
    error.status = response.status;
    error.code = data.error;
    error.data = data;
    throw error;
  }
  return data;
}

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------
export function fetchFacets() {
  return request("/api/shop/facets");
}

// Display conversion rates, set by an admin. Fetched once on load; until they
// arrive the storefront offers USD only rather than guessing.
export function fetchRates() {
  return request("/api/shop/rates");
}

export function fetchProducts(params) {
  const query = new URLSearchParams(
    Object.fromEntries(Object.entries(params).map(([key, value]) => [key, String(value)]))
  );
  return request(`/api/shop/products?${query}`);
}

export function fetchProduct(id) {
  return request(`/api/shop/products/${encodeURIComponent(id)}`);
}

// Related products for the detail view: dearer neighbours ("better versions")
// and comparable ones. Never blocks the product itself — the caller ignores a
// failure here.
export function fetchRecommendations(id, limit = 4) {
  const params = new URLSearchParams({ limit: String(limit) });
  return request(`/api/shop/products/${encodeURIComponent(id)}/recommendations?${params}`);
}

export function fetchSuggestions(query, limit = 6) {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  return request(`/api/shop/suggest?${params}`);
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------
// Creates an inert account and emails a code; no session exists until
// verifyEmail() is called with it.
export function register({ email, password, name }) {
  return request("/api/auth/register", { method: "POST", body: { email, password, name } });
}

export function login({ email, password, remember }) {
  return request("/api/auth/login", { method: "POST", body: { email, password, remember } });
}

export function logout() {
  return request("/api/auth/logout", { method: "POST" });
}

// Called once on load. A valid access token answers immediately; otherwise the
// refresh token — which outlives it by 30 days — silently signs the customer
// back in, so returning to the shop doesn't mean logging in again.
export async function restoreSession() {
  const { user } = await request("/api/auth/me");
  if (user) return user;
  return refreshSession();
}

// Which third-party sign-in options this deployment has configured. Asked once
// when the modal opens, so the button only appears where it actually works.
export function fetchAuthProviders() {
  return request("/api/auth/providers");
}

// Step one of the two-step form: decide whether to ask for a password or offer
// to create an account.
export function lookupEmail(email) {
  return request("/api/auth/lookup", { method: "POST", body: { email } });
}

export function verifyEmail({ email, code, remember }) {
  return request("/api/auth/verify-email", { method: "POST", body: { email, code, remember } });
}

export function resendCode({ email, purpose }) {
  return request("/api/auth/resend-code", { method: "POST", body: { email, purpose } });
}

export function verifyTwoFactor(code) {
  return request("/api/auth/two-factor", { method: "POST", body: { code } });
}

export function forgotPassword(email) {
  return request("/api/auth/forgot-password", { method: "POST", body: { email } });
}

export function resetPassword({ email, code, password }) {
  return request("/api/auth/reset-password", { method: "POST", body: { email, code, password } });
}

// ---------------------------------------------------------------------------
// Account management
// ---------------------------------------------------------------------------
export function updateProfile(name) {
  return request("/api/auth/profile", { method: "PATCH", body: { name } });
}

export function changePassword({ currentPassword, newPassword }) {
  return request("/api/auth/change-password", { method: "POST", body: { currentPassword, newPassword } });
}

export function fetchSessions() {
  return request("/api/auth/sessions");
}

export function signOutOtherSessions() {
  return request("/api/auth/sessions", { method: "DELETE" });
}

export function setupTwoFactor() {
  return request("/api/auth/totp/setup", { method: "POST" });
}

export function enableTwoFactor(code) {
  return request("/api/auth/totp/enable", { method: "POST", body: { code } });
}

export function disableTwoFactor(password) {
  return request("/api/auth/totp/disable", { method: "POST", body: { password } });
}

export function fetchOrders() {
  return request("/api/shop/orders");
}

// ---------------------------------------------------------------------------
// Basket
// ---------------------------------------------------------------------------
export function fetchCart() {
  return request("/api/shop/cart");
}

export function addToCart(itemId, quantity = 1) {
  return request("/api/shop/cart", { method: "POST", body: { itemId, quantity } });
}

export function setCartQuantity(itemId, quantity) {
  return request(`/api/shop/cart/${encodeURIComponent(itemId)}`, { method: "PATCH", body: { quantity } });
}

export function removeFromCart(itemId) {
  return request(`/api/shop/cart/${encodeURIComponent(itemId)}`, { method: "DELETE" });
}

export function clearCart() {
  return request("/api/shop/cart", { method: "DELETE" });
}

export function fetchLatestDelivery() {
  return request("/api/shop/delivery/latest");
}

export function checkout(delivery) {
  return request("/api/shop/cart/checkout", { method: "POST", body: { delivery } });
}
