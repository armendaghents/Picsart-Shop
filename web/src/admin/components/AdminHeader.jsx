import { useEffect, useState } from "react";

import { fetchAdminSession, logout } from "../api";

export default function AdminHeader({ dark, onToggleDark, onAddItem }) {
  // Empty unless the console is running named accounts, so the single shared
  // login looks exactly as it did before.
  const [username, setUsername] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetchAdminSession()
      .then((session) => {
        if (!cancelled) setUsername(session.username || "");
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

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
        {username ? <span className="admin-whoami" title="Signed in as">{username}</span> : null}
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
