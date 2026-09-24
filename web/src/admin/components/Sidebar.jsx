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
          className={`nav-item${activeView === "orders" ? " active" : ""}`}
          type="button"
          title="Orders"
          onClick={() => onNavigate("orders")}
        >
          <span>❑</span>
          <span>Orders</span>
        </button>
        <button
          className={`nav-item${activeView === "rates" ? " active" : ""}`}
          type="button"
          title="Currencies"
          onClick={() => onNavigate("rates")}
        >
          <span>⇄</span>
          <span>Currencies</span>
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
