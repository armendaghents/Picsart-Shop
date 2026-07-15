import { logout } from "../api";

export default function AdminHeader({ dark, onToggleDark, onAddItem }) {
  return (
    <header className="topbar">
      <div>
        <p className="eyebrow">Enterprise Search Platform</p>
        <h1>Find products, assets, documents, and locations instantly.</h1>
      </div>
      <div className="top-actions">
        <a className="icon-button link-button" href="/" title="Open customer storefront">
          🛍
        </a>
        <button className="icon-button" type="button" title="Toggle theme" onClick={onToggleDark}>
          {dark ? "☀" : "◐"}
        </button>
        <button className="text-button" type="button" onClick={logout}>
          Log out
        </button>
        <button className="command-button" type="button" onClick={onAddItem}>
          <span>＋</span>
          <span>Add Item</span>
        </button>
      </div>
    </header>
  );
}
