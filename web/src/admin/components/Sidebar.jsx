export default function Sidebar({ resultCount }) {
  const healthScore = 98;

  return (
    <aside className="sidebar" aria-label="Primary navigation">
      <a className="brand" href="/">
        <span className="brand-mark">A</span>
        <div>
          <strong>Atlas Search</strong>
          <span>Admin Console</span>
        </div>
      </a>

      <nav className="nav">
        <button className="nav-item active" type="button" title="Search">
          <span>⌕</span>
          <span>Search</span>
        </button>
        <button className="nav-item" type="button" title="Inventory">
          <span>▦</span>
          <span>Inventory</span>
        </button>
        <button className="nav-item" type="button" title="Warehouses">
          <span>⌂</span>
          <span>Warehouses</span>
        </button>
        <button className="nav-item" type="button" title="Analytics">
          <span>◷</span>
          <span>Analytics</span>
        </button>
      </nav>

      <section className="side-panel">
        <div className="side-panel-header">
          <span>Search Health</span>
          <strong>{healthScore}%</strong>
        </div>
        <div className="meter">
          <span style={{ width: `${healthScore}%` }} />
        </div>
        <p>Hybrid ranking, typo tolerance, synonyms, and field boosting enabled. {resultCount} items indexed.</p>
      </section>
    </aside>
  );
}
