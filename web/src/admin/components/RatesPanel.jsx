import { useEffect, useState } from "react";
import { deleteRate, fetchRates, saveRate } from "../api";

// Stored UTC as "YYYY-MM-DD HH:MM:SS".
function formatWhen(value) {
  if (!value) return "—";
  return new Date(`${value.replace(" ", "T")}Z`).toLocaleString();
}

export default function RatesPanel() {
  const [base, setBase] = useState("USD");
  const [rates, setRates] = useState([]);
  const [drafts, setDrafts] = useState({});
  const [newCode, setNewCode] = useState("");
  const [newRate, setNewRate] = useState("");
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  function load() {
    setLoading(true);
    fetchRates()
      .then((data) => {
        setBase(data.base);
        setRates(data.rates);
        setDrafts(Object.fromEntries(data.rates.map((row) => [row.code, String(row.rate)])));
      })
      .catch((problem) => setError(problem.message))
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  async function run(key, action) {
    setBusy(key);
    setError("");
    try {
      await action();
      load();
    } catch (problem) {
      setError(problem.message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="rates-panel">
      <header className="rates-intro">
        <h2>Display currencies</h2>
        <p>
          The shop prices and charges in <strong>{base}</strong>. These rates only change what a customer
          sees on the shelf — the storefront labels converted figures as approximate and states the {base}{" "}
          amount before checkout. A rate is how many units one {base} buys.
        </p>
      </header>

      {error && <p className="orders-error">{error}</p>}

      {loading ? (
        <p className="empty-state">Loading…</p>
      ) : (
        <ul className="rates-list">
          {rates.map((row) => {
            const isBase = row.code === base;
            const draft = drafts[row.code] ?? "";
            const changed = draft !== String(row.rate);
            return (
              <li key={row.code} className="rates-row">
                <span className="rates-code">{row.code}</span>
                <input
                  className="rates-input"
                  type="number"
                  step="any"
                  min="0"
                  value={draft}
                  // The base currency is the unit everything else is measured
                  // against; editing it would silently reprice the whole shop.
                  disabled={isBase || busy === row.code}
                  onChange={(event) => setDrafts((current) => ({ ...current, [row.code]: event.target.value }))}
                />
                <span className="rates-meta">
                  {isBase ? "the currency the shop prices in" : `set by ${row.updated_by || "—"} · ${formatWhen(row.updated_at)}`}
                </span>
                {!isBase && (
                  <span className="rates-actions">
                    <button
                      type="button"
                      className="orders-action"
                      disabled={!changed || busy === row.code}
                      onClick={() => run(row.code, () => saveRate(row.code, Number(draft)))}
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      className="orders-action orders-action-cancelled"
                      disabled={busy === row.code}
                      onClick={() => run(row.code, () => deleteRate(row.code))}
                    >
                      Remove
                    </button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <form
        className="rates-add"
        onSubmit={(event) => {
          event.preventDefault();
          run("new", async () => {
            await saveRate(newCode.trim().toUpperCase(), Number(newRate));
            setNewCode("");
            setNewRate("");
          });
        }}
      >
        <input
          className="rates-input"
          value={newCode}
          onChange={(event) => setNewCode(event.target.value)}
          placeholder="EUR"
          maxLength={3}
          aria-label="Currency code"
          required
        />
        <input
          className="rates-input"
          type="number"
          step="any"
          min="0"
          value={newRate}
          onChange={(event) => setNewRate(event.target.value)}
          placeholder={`units per 1 ${base}`}
          aria-label="Rate"
          required
        />
        <button type="submit" className="orders-action" disabled={busy === "new"}>
          Add currency
        </button>
      </form>
    </section>
  );
}
