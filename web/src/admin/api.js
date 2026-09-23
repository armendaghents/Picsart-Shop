// Every state-changing admin call echoes the atlas_csrf cookie back in a
// header. That cookie is the only one this script can read; the session cookie
// that actually authenticates the request is HttpOnly and invisible here, so a
// page on another origin can neither read it nor forge the header.
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function readCookie(name) {
  const prefix = `${name}=`;
  const match = document.cookie.split("; ").find((entry) => entry.startsWith(prefix));
  return match ? decodeURIComponent(match.slice(prefix.length)) : "";
}

async function request(url, options = {}) {
  const method = options.method || "GET";
  const headers = { ...(options.headers || {}) };
  if (!SAFE_METHODS.has(method.toUpperCase())) {
    headers["X-CSRF-Token"] = readCookie("atlas_csrf");
  }

  const response = await fetch(url, { ...options, method, headers, credentials: "same-origin" });
  if (response.status === 401) {
    window.location.reload();
    throw new Error("Session expired, reloading for login.");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || `Request failed: ${response.status}`);
  return data;
}

// Who is signed in. With named accounts (ADMIN_USERS) this carries a username;
// with the single shared login it doesn't, and the header shows nothing.
export function fetchAdminSession() {
  return request("/api/admin/session");
}

export function fetchDashboard() {
  return request("/api/dashboard");
}

export function fetchFacets(category = "All") {
  return request(`/api/facets?category=${encodeURIComponent(category)}`);
}

// Minutes to ADD to UTC to get this browser's local time, so the server can
// bucket orders into the admin's local calendar day instead of the UTC day.
function localTzOffset() {
  return -new Date().getTimezoneOffset();
}

export function fetchOrderSummary(month) {
  return request(`/api/analytics/orders/summary?month=${encodeURIComponent(month)}&tzOffset=${localTzOffset()}`);
}

export function fetchOrdersForDay(date) {
  return request(`/api/analytics/orders/day?date=${encodeURIComponent(date)}&tzOffset=${localTzOffset()}`);
}

export function fetchInventory(params) {
  const query = new URLSearchParams(
    Object.fromEntries(Object.entries(params).map(([key, value]) => [key, String(value)]))
  );
  return request(`/api/inventory?${query}`);
}

export function fetchItem(id) {
  return request(`/api/inventory/${encodeURIComponent(id)}`);
}

export function createItem(data) {
  return request("/api/inventory", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export function updateItem(id, data) {
  return request(`/api/inventory/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export function uploadImage(file) {
  const formData = new FormData();
  formData.append("image", file);
  return request("/api/admin/upload", { method: "POST", body: formData });
}

export function uploadImages(files) {
  const formData = new FormData();
  for (const file of files) formData.append("images", file);
  return request("/api/admin/upload-multiple", { method: "POST", body: formData });
}

export function deleteUploadedImage(url) {
  return request("/api/admin/upload", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
}

export function deleteItem(id) {
  return request(`/api/inventory/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function logout() {
  // Through request() so the CSRF header is attached; a 401 here just means the
  // session was already gone, which is the outcome we wanted anyway.
  await request("/api/admin/logout", { method: "POST" }).catch(() => {});
  window.location.href = "/admin";
}
