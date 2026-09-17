import { useEffect, useState } from "react";
import {
  changePassword,
  disableTwoFactor,
  enableTwoFactor,
  fetchOrders,
  fetchSessions,
  setupTwoFactor,
  signOutOtherSessions,
  updateProfile,
} from "../api";
import { formatMoney } from "../currency";

// Timestamps arrive as UTC "YYYY-MM-DD HH:MM:SS" strings.
function formatWhen(value) {
  if (!value) return "";
  const date = new Date(`${value.replace(" ", "T")}Z`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

// A user agent string is unreadable; the browser and platform are the part
// someone can actually recognise as "my laptop".
function describeDevice(userAgent) {
  if (!userAgent) return "—";
  const browser = /Edg/.test(userAgent) ? "Edge"
    : /OPR|Opera/.test(userAgent) ? "Opera"
    : /Chrome/.test(userAgent) ? "Chrome"
    : /Safari/.test(userAgent) ? "Safari"
    : /Firefox/.test(userAgent) ? "Firefox"
    : null;
  const platform = /iPhone|iPad/.test(userAgent) ? "iOS"
    : /Android/.test(userAgent) ? "Android"
    : /Mac OS X/.test(userAgent) ? "macOS"
    : /Windows/.test(userAgent) ? "Windows"
    : /Linux/.test(userAgent) ? "Linux"
    : null;
  return [browser, platform].filter(Boolean).join(" · ") || userAgent.slice(0, 40);
}

export default function AccountPanel({ t, user, currency, onClose, onUserChange, initialTab = "details" }) {
  const [tab, setTab] = useState(initialTab);
  return (
    <div className="cart-overlay" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <aside className="cart-panel account-panel" role="dialog" aria-modal="true" aria-label={t.myAccount}>
        <header className="cart-header">
          <h2>{t.myAccount}</h2>
          <button className="modal-close" type="button" onClick={onClose} aria-label={t.close}>
            ×
          </button>
        </header>

        <nav className="account-tabs">
          {[
            ["details", t.accountDetails],
            ["security", t.security],
            ["orders", t.orderHistory],
          ].map(([key, label]) => (
            <button key={key} type="button" className={tab === key ? "active" : ""} onClick={() => setTab(key)}>
              {label}
            </button>
          ))}
        </nav>

        <div className="account-body">
          {tab === "details" && <Details t={t} user={user} onUserChange={onUserChange} />}
          {tab === "security" && <Security t={t} user={user} onUserChange={onUserChange} />}
          {tab === "orders" && <Orders t={t} currency={currency} />}
        </div>
      </aside>
    </div>
  );
}

function Details({ t, user, onUserChange }) {
  const [name, setName] = useState(user.name || "");
  const [state, setState] = useState("idle");
  const [error, setError] = useState("");

  async function save(event) {
    event.preventDefault();
    setState("saving");
    setError("");
    try {
      const result = await updateProfile(name);
      onUserChange(result.user);
      setState("saved");
    } catch (saveError) {
      setError(saveError.message);
      setState("idle");
    }
  }

  return (
    <section className="account-section">
      <p className="account-email">{user.email}</p>
      <p className="account-meta">{t.memberSince(formatWhen(user.createdAt))}</p>

      <form onSubmit={save}>
        <label>
          {t.nameOptional}
          <input value={name} onChange={(event) => { setName(event.target.value); setState("idle"); }} maxLength={100} />
        </label>
        {error && <p className="auth-error">{error}</p>}
        <button className="auth-submit" type="submit" disabled={state === "saving"}>
          {state === "saving" ? t.working : state === "saved" ? t.saved : t.save}
        </button>
      </form>
    </section>
  );
}

function Security({ t, user, onUserChange }) {
  return (
    <>
      <PasswordSection t={t} />
      <TwoFactorSection t={t} user={user} onUserChange={onUserChange} />
      <SessionsSection t={t} />
    </>
  );
}

function PasswordSection({ t }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [state, setState] = useState("idle");
  const [error, setError] = useState("");

  async function save(event) {
    event.preventDefault();
    setState("saving");
    setError("");
    try {
      await changePassword({ currentPassword, newPassword });
      setCurrentPassword("");
      setNewPassword("");
      setState("saved");
    } catch (saveError) {
      setError(saveError.message);
      setState("idle");
    }
  }

  return (
    <section className="account-section">
      <h3>{t.savePassword}</h3>
      <form onSubmit={save}>
        <label>
          {t.currentPassword}
          <input type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoComplete="current-password" required />
        </label>
        <label>
          {t.newPassword}
          <input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} autoComplete="new-password" minLength={8} required />
        </label>
        <p className="auth-hint">{t.passwordHint}</p>
        {error && <p className="auth-error">{error}</p>}
        <button className="auth-submit" type="submit" disabled={state === "saving"}>
          {state === "saving" ? t.working : state === "saved" ? t.saved : t.savePassword}
        </button>
      </form>
    </section>
  );
}

function TwoFactorSection({ t, user, onUserChange }) {
  const [stage, setStage] = useState("idle"); // idle | enrolling | codes | disabling
  const [enrolment, setEnrolment] = useState(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function run(action) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (actionError) {
      setError(actionError.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="account-section">
      <h3>{t.twoStep}</h3>
      <p className="account-meta">{user.twoFactorEnabled ? t.twoStepOn : t.twoStepOff}</p>

      {stage === "idle" && (
        <button
          className="auth-submit"
          type="button"
          disabled={busy}
          onClick={() =>
            user.twoFactorEnabled
              ? setStage("disabling")
              : run(async () => {
                  setEnrolment(await setupTwoFactor());
                  setCode("");
                  setStage("enrolling");
                })
          }
        >
          {user.twoFactorEnabled ? t.turnOff : t.turnOn}
        </button>
      )}

      {stage === "enrolling" && enrolment && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            run(async () => {
              const result = await enableTwoFactor(code);
              setRecoveryCodes(result.recoveryCodes);
              onUserChange({ ...user, twoFactorEnabled: true });
              setStage("codes");
            });
          }}
        >
          <p className="account-meta">{t.scanQr}</p>
          <img className="totp-qr" src={enrolment.qr} alt="" width="200" height="200" />
          <p className="account-meta">{t.manualKey}</p>
          <code className="totp-secret">{enrolment.secret}</code>
          <label>
            {t.verificationCode}
            <input className="code-input" value={code} onChange={(event) => setCode(event.target.value)} inputMode="numeric" maxLength={6} required />
          </label>
          {error && <p className="auth-error">{error}</p>}
          <button className="auth-submit" type="submit" disabled={busy}>
            {busy ? t.working : t.turnOn}
          </button>
        </form>
      )}

      {stage === "codes" && (
        <div>
          <h4>{t.recoveryCodesTitle}</h4>
          <p className="account-meta">{t.recoveryCodesHint}</p>
          <ul className="recovery-codes">
            {recoveryCodes.map((recoveryCode) => (
              <li key={recoveryCode}>{recoveryCode}</li>
            ))}
          </ul>
          <button className="auth-submit" type="button" onClick={() => setStage("idle")}>
            {t.done}
          </button>
        </div>
      )}

      {stage === "disabling" && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            run(async () => {
              await disableTwoFactor(password);
              onUserChange({ ...user, twoFactorEnabled: false });
              setPassword("");
              setStage("idle");
            });
          }}
        >
          <label>
            {t.password}
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required />
          </label>
          {error && <p className="auth-error">{error}</p>}
          <button className="auth-submit" type="submit" disabled={busy}>
            {busy ? t.working : t.turnOff}
          </button>
        </form>
      )}
    </section>
  );
}

function SessionsSection({ t }) {
  const [sessions, setSessions] = useState([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetchSessions()
      .then((data) => setSessions(data.sessions || []))
      .catch(() => {});
  }, []);

  return (
    <section className="account-section">
      <h3>{t.devices}</h3>
      <ul className="session-list">
        {sessions.map((session) => (
          <li key={session.id}>
            <div>
              <strong>{describeDevice(session.device)}</strong>
              {session.current && <span className="session-current">{t.currentDevice}</span>}
            </div>
            <span className="account-meta">
              {session.ip} · {t.lastUsed(formatWhen(session.lastUsedAt))}
            </span>
          </li>
        ))}
      </ul>
      {sessions.length > 1 && (
        <button
          className="auth-submit"
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await signOutOtherSessions();
              const data = await fetchSessions();
              setSessions(data.sessions || []);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? t.working : t.signOutEverywhere}
        </button>
      )}
    </section>
  );
}

function Orders({ t, currency }) {
  const [orders, setOrders] = useState(null);

  useEffect(() => {
    fetchOrders()
      .then((data) => setOrders(data.orders || []))
      .catch(() => setOrders([]));
  }, []);

  if (orders === null) return <p className="account-meta">{t.working}</p>;
  if (!orders.length) return <p className="account-meta">{t.noOrders}</p>;

  return (
    <section className="account-section">
      {orders.map((order) => (
        <article key={order.placedAt} className="order-card">
          <header>
            <strong>{t.orderOn(formatWhen(order.placedAt))}</strong>
            <span>{formatMoney(order.total, currency, "USD")}</span>
          </header>
          <ul>
            {order.lines.map((line) => (
              <li key={line.id}>
                <span>
                  {line.quantity > 1 && `${line.quantity} × `}
                  {line.name || line.sku || "—"}
                </span>
                <span>{formatMoney(line.price * line.quantity, currency, "USD")}</span>
              </li>
            ))}
          </ul>
        </article>
      ))}
    </section>
  );
}
