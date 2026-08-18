const formatMoney = (amount) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(amount || 0);

export default function FiltersSidebar({ facets, filters, onChange, onReset }) {
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
        Model
        <select value={filters.model} onChange={(event) => onChange({ model: event.target.value })}>
          <option value="All">All</option>
          {facets.models.map((name) => (
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
          disabled={!Number.isFinite(filters.maxPrice)}
          value={Number.isFinite(filters.maxPrice) ? filters.maxPrice : 10000}
          onChange={(event) => onChange({ maxPrice: Number(event.target.value) })}
        />
        <span>{Number.isFinite(filters.maxPrice) ? formatMoney(filters.maxPrice) : "No limit"}</span>
      </label>
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={!Number.isFinite(filters.maxPrice)}
          onChange={(event) => onChange({ maxPrice: event.target.checked ? Infinity : 10000 })}
        />
        No limit (show items over $10,000)
      </label>
    </aside>
  );
}
