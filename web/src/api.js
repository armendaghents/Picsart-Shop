async function getJson(url) {
  const response = await fetch(url);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || `Request failed: ${response.status}`);
  return data;
}

export function fetchFacets() {
  return getJson("/api/shop/facets");
}

export function fetchProducts(params) {
  const query = new URLSearchParams(
    Object.fromEntries(Object.entries(params).map(([key, value]) => [key, String(value)]))
  );
  return getJson(`/api/shop/products?${query}`);
}

export function fetchProduct(id) {
  return getJson(`/api/shop/products/${encodeURIComponent(id)}`);
}

export function fetchSuggestions(query, limit = 6) {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  return getJson(`/api/shop/suggest?${params}`);
}

export async function placeOrder(id) {
  const response = await fetch("/api/shop/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ itemId: id }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || `Request failed: ${response.status}`);
  return data;
}
