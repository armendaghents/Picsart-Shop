const formatMoney = (amount) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(amount || 0);

function topFacets(items) {
  const counts = items.reduce((map, item) => {
    for (const tag of item.tags.slice(0, 4)) map.set(tag, (map.get(tag) || 0) + 1);
    return map;
  }, new Map());
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
}

export default function FiltersSidebar({ facets, filters, onChange, onReset, items }) {
  const facetList = topFacets(items);

  return (
    <aside className="filters" aria-label="Search filters">
      <div className="filter-head">
        <h2>Filters</h2>
        <button className="text-button" type="button" onClick={onReset}>
          Reset
        </button>
      </div>

      <label>
        Category
        <select value={filters.category} onChange={(event) => onChange({ category: event.target.value })}>
          <option value="All">All</option>
          {facets.categories.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>

      <label>
        Warehouse
        <select value={filters.warehouse} onChange={(event) => onChange({ warehouse: event.target.value })}>
          <option value="All">All</option>
          {facets.warehouses.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>

      <label>
        Status
        <select value={filters.status} onChange={(event) => onChange({ status: event.target.value })}>
          <option value="All">All</option>
          {facets.statuses.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>

      <label>
        Maximum price
        <input
          type="range"
          min="0"
          max="10000"
          step="100"
          value={filters.maxPrice}
          onChange={(event) => onChange({ maxPrice: Number(event.target.value) })}
        />
        <span>{formatMoney(filters.maxPrice)}</span>
      </label>

      <div className="facets">
        <h3>Top Facets</h3>
        <div className="facet-list">
          {facetList.length ? (
            facetList.map(([name, count]) => (
              <span className="facet" key={name}>
                {name} · {count}
              </span>
            ))
          ) : (
            <span className="facet">No facets</span>
          )}
        </div>
      </div>
    </aside>
  );
}
