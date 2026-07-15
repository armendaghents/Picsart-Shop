function buildSuggestions(items) {
  const lowStock = items.find((item) => item.availableQuantity <= 5 && item.availableQuantity > 0);
  const topMatch = items[0];

  return [
    lowStock
      ? `Reorder ${lowStock.name}; available quantity is ${lowStock.availableQuantity}.`
      : "No urgent replenishment risk in this result set.",
    topMatch ? `Top match: ${topMatch.name} ranks highest for this query.` : "Try SKU, serial, OCR text, or a natural language phrase.",
    "Synonym expansion links pc, computer, desktop, and workstation queries.",
  ];
}

export default function InsightsPanel({ items }) {
  const suggestions = buildSuggestions(items);

  return (
    <aside className="insights" aria-label="AI insights">
      <div className="insight-card">
        <div className="section-title">
          <h2>AI Suggestions</h2>
          <span>Live</span>
        </div>
        <div className="suggestions">
          {suggestions.map((suggestion) => (
            <div className="suggestion" key={suggestion}>
              {suggestion}
            </div>
          ))}
        </div>
      </div>

      <div className="insight-card">
        <div className="section-title">
          <h2>Activity</h2>
          <span>Audit</span>
        </div>
        <ol className="activity">
          <li>Cycle count completed in West Hub.</li>
          <li>3 duplicate SKU candidates detected.</li>
          <li>New OCR manual indexed for power units.</li>
        </ol>
      </div>
    </aside>
  );
}
