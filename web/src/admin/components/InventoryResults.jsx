import { highlight } from "../highlight.jsx";
import Pagination from "../../components/Pagination";

const formatMoney = (amount) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(amount || 0);

function availabilityClass(label) {
  return `status-pill status-${label.replace(/\s+/g, "-").toLowerCase()}`;
}

function conditionClass(condition) {
  return `condition-pill condition-${condition.toLowerCase()}`;
}

export default function InventoryResults({ items, total, query, sort, onSortChange, onEdit, onDelete, page, totalPages, onPageChange }) {
  return (
    <section className="results-panel" aria-label="Search results">
      <div className="result-toolbar">
        <div>
          <h2>{query ? `Results for "${query}"` : "Inventory"}</h2>
          <p>{total} matching items · sorted by {sort}</p>
        </div>
        <select aria-label="Sort results" value={sort} onChange={(event) => onSortChange(event.target.value)}>
          <option value="relevance">Relevance</option>
          <option value="priceDesc">Highest value</option>
          <option value="priceAsc">Lowest value</option>
          <option value="stock">Most stock</option>
          <option value="recent">Recently added</option>
        </select>
      </div>

      {!items.length ? (
        <div className="empty-state">No inventory matches the current query and filters.</div>
      ) : (
        <div className="results">
          {items.map((item) => (
            <article className="product-card" key={item.id}>
              <button
                type="button"
                className="product-card-clickzone"
                onClick={() => onEdit(item)}
                aria-label={`Edit ${item.name}`}
              />
              <div className="product-art" style={{ "--art-a": item.colors[0], "--art-b": item.colors[1] }}>
                {item.image ? <img src={item.image} alt={item.name} /> : <span>{item.icon}</span>}
              </div>
              <div className="product-main">
                <h3>{highlight(item.name, query)}</h3>
                <p>{highlight(item.description, query)}</p>
                <div className="meta-row">
                  <span>{item.sku}</span>
                  {item.category && <span>{item.category.split(">").map((part) => part.trim()).at(-1)}</span>}
                  <span>{item.warehouse ? [item.warehouse, item.location].filter(Boolean).join(" · ") : "Unassigned"}</span>
                  <span className={availabilityClass(item.availability)}>{item.availability}</span>
                  {item.condition && <span className={conditionClass(item.condition)}>{item.condition}</span>}
                </div>
              </div>
              <div className="product-side">
                <span className="score">{Math.min(100, item.score)} match</span>
                <span className="price">{formatMoney(item.price)}</span>
                <span className="stock">{item.availableQuantity} available</span>
                <div className="product-actions">
                  <button type="button" className="text-button" onClick={() => onEdit(item)}>
                    Edit
                  </button>
                  <button
                    type="button"
                    className="text-button text-danger"
                    onClick={(event) => {
                      event.stopPropagation();
                      onDelete(item);
                    }}
                  >
                    Delete
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}

      <Pagination page={page} totalPages={totalPages} onPageChange={onPageChange} />
    </section>
  );
}
