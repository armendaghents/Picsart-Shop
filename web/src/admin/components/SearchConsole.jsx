export default function SearchConsole({ query, onQueryChange }) {
  return (
    <section className="search-console" aria-label="Search console">
      <div className="search-box">
        <span className="search-icon">⌕</span>
        <input
          type="text"
          autoComplete="off"
          placeholder="Search SKU, barcode, serial, category, OCR text, or natural language"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          autoFocus
        />
        {query && (
          <button className="icon-button subtle" type="button" title="Clear search" onClick={() => onQueryChange("")}>
            ×
          </button>
        )}
      </div>
    </section>
  );
}
