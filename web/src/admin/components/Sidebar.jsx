export default function Sidebar({ activeView, onNavigate }) {
  return (
    <aside className="sidebar" aria-label="Primary navigation">
      <a className="brand" href="/">
        <img className="brand-mark" src="/picsart-logo.jpeg" alt="Picsart" />
        <div>
          <strong>Picsart Shop</strong>
          <span>Admin Console</span>
        </div>
      </a>

      <nav className="nav">
        <button
          className={`nav-item${activeView === "search" ? " active" : ""}`}
          type="button"
          title="Search"
          onClick={() => onNavigate("search")}
        >
          <span>⌕</span>
          <span>Search</span>
        </button>
        <button
          className={`nav-item${activeView === "search" ? " active" : ""}`}
          type="button"
          title="Inventory"
          onClick={() => onNavigate("search")}
        >
          <span>▦</span>
          <span>Inventory</span>
        </button>
        <button
          className={`nav-item${activeView === "analytics" ? " active" : ""}`}
          type="button"
          title="Analytics"
          onClick={() => onNavigate("analytics")}
        >
          <span>◷</span>
          <span>Analytics</span>
        </button>
      </nav>
    </aside>
  );
}
