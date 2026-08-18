async function request(url, options) {
  const response = await fetch(url, options);
  if (response.status === 401) {
    window.location.reload();
    throw new Error("Session expired, reloading for login.");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || `Request failed: ${response.status}`);
  return data;
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
  await fetch("/api/admin/logout", { method: "POST" });
  window.location.href = "/admin";
}
