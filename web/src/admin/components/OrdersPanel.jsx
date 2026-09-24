import { useEffect, useRef, useState } from "react";
import { fetchAdminOrders, updateOrderStatus } from "../api";
import Pagination from "../../components/Pagination";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";

// Tabs, in the order an order actually moves through them, so the row of tabs
// reads as the lifecycle rather than an alphabetical list.
const TABS = [
  { key: "all", label: "All" },
  { key: "pending", label: "Awaiting payment" },
  { key: "paid", label: "To pack" },
  { key: "shipped", label: "Shipped" },
  { key: "cancelled", label: "Cancelled" },
  { key: "refunded", label: "Refunded" },
];

// The verb that describes the move, not the state it lands in: "Mark shipped"
// is an instruction, "shipped" is a label, and a button should be the former.
const ACTION_LABELS = {
  paid: "Mark paid",
  shipped: "Mark shipped",
  cancelled: "Cancel",
  refunded: "Refund",
};

// Stored UTC as "YYYY-MM-DD HH:MM:SS"; the T and Z make it parse as UTC rather
// than as local time, which would shift every order by the viewer's offset.
function formatWhen(value) {
  if (!value) return "—";
  return new Date(`${value.replace(" ", "T")}Z`).toLocaleString();
}

function formatMoney(amount, currency) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: currency || "USD" }).format(amount || 0);
}

function addressLines(delivery) {
  if (delivery.method === "pickup") return ["Collection in person"];
  return [
    delivery.line1,
    delivery.line2,
    [delivery.postalCode, delivery.city].filter(Boolean).join(" "),
    delivery.country,
  ].filter(Boolean);
}

export default function OrdersPanel() {
  const [tab, setTab] = useState("all");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ orders: [], counts: {}, total: 0, totalPages: 1 });
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(null);
  // Which order is mid-change, so only its own buttons go quiet rather than
  // the whole list freezing.
  const [working, setWorking] = useState(null);
  const [error, setError] = useState("");

  const debouncedQuery = useDebouncedValue(query, 250);

  function load(targetPage = page) {
    setLoading(true);
    fetchAdminOrders({ status: tab, q: debouncedQuery, page: targetPage })
      .then((result) => {
        setData(result);
        if (result.page && result.page !== targetPage) setPage(result.page);
      })
      .catch((problem) => setError(problem.message))
      .finally(() => setLoading(false));
  }

  // One effect, not one per input. A filter change and a page change both want
  // to reload, but two effects would each fire on mount and race — the slower
  // response winning and overwriting the right one. Tracking the filter
  // signature in a ref is how the inventory list above solves the same problem:
  // a filter change resets to page 1 and loads once.
  const filtersSignature = JSON.stringify([tab, debouncedQuery]);
  const previousFiltersSignature = useRef(filtersSignature);

  useEffect(() => {
    const filtersChanged = previousFiltersSignature.current !== filtersSignature;
    previousFiltersSignature.current = filtersSignature;
    // Staying on page 4 of a result set that no longer has one shows an empty
    // list for no clear reason.
    const targetPage = filtersChanged ? 1 : page;
    if (filtersChanged && page !== 1) setPage(1);
    load(targetPage);
  }, [filtersSignature, page]);

  async function changeStatus(order, status) {
    setWorking(order.id);
    setError("");
    try {
      await updateOrderStatus(order.id, status);
      load();
    } catch (problem) {
      setError(problem.message);
    } finally {
      setWorking(null);
    }
  }

  return (
    <section className="orders-panel">
      <header className="orders-toolbar">
        <div className="orders-tabs">
          {TABS.map((entry) => {
            const count = entry.key === "all"
              ? Object.values(data.counts || {}).reduce((sum, value) => sum + value, 0)
              : data.counts?.[entry.key] || 0;
            return (
              <button
                key={entry.key}
                type="button"
                className={`orders-tab${tab === entry.key ? " active" : ""}`}
                onClick={() => setTab(entry.key)}
              >
                {entry.label}
                <span className="orders-tab-count">{count}</span>
              </button>
            );
          })}
        </div>

        <input
          className="orders-search"
          type="search"
          value={query}
          placeholder="Order number, email, or recipient"
          onChange={(event) => setQuery(event.target.value)}
        />
      </header>

      {error && <p className="orders-error">{error}</p>}

      {loading ? (
        <p className="empty-state">Loading…</p>
      ) : !data.orders.length ? (
        <p className="empty-state">No orders here.</p>
      ) : (
        <ul className="orders-list">
          {data.orders.map((order) => (
            <li key={order.id} className="orders-row">
              <button
                type="button"
                className="orders-row-head"
                onClick={() => setExpanded(expanded === order.id ? null : order.id)}
                aria-expanded={expanded === order.id}
              >
                <span className="orders-number">{order.orderNumber}</span>
                <span className={`order-status order-status-${order.status}`}>{order.status}</span>
                <span className="orders-who">{order.buyerEmail || "—"}</span>
                <span className="orders-when">{formatWhen(order.placedAt)}</span>
                <span className="orders-total">{formatMoney(order.total, order.currency)}</span>
              </button>

              {expanded === order.id && (
                <div className="orders-detail">
                  <div className="orders-detail-grid">
                    <div>
                      <h4>Items</h4>
                      <ul className="order-line-list">
                        {order.lines.map((line) => (
                          <li key={line.id}>
                            <span>
                              {line.quantity > 1 && `${line.quantity} × `}
                              {line.name || line.sku || "—"}
                            </span>
                            <span>{formatMoney(line.lineTotal, order.currency)}</span>
                          </li>
                        ))}
                      </ul>
                    </div>

                    <div>
                      <h4>{order.delivery.method === "pickup" ? "Collection" : "Ship to"}</h4>
                      <p className="orders-address">
                        <strong>{order.delivery.name || "—"}</strong>
                        <span>{order.delivery.phone || "—"}</span>
                        {addressLines(order.delivery).map((line) => (
                          <span key={line}>{line}</span>
                        ))}
                      </p>
                      {order.delivery.notes && <p className="orders-note">“{order.delivery.notes}”</p>}
                    </div>
                  </div>

                  <div className="orders-actions">
                    {/* Offered by the server from the same transition table it
                        enforces, so a button can never ask for a move that
                        will come back rejected. A terminal order gets none. */}
                    {order.nextStatuses.length ? (
                      order.nextStatuses.map((status) => (
                        <button
                          key={status}
                          type="button"
                          className={`orders-action orders-action-${status}`}
                          disabled={working === order.id}
                          onClick={() => changeStatus(order, status)}
                        >
                          {ACTION_LABELS[status] || status}
                        </button>
                      ))
                    ) : (
                      <span className="orders-terminal">Nothing further to do.</span>
                    )}
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <Pagination page={data.page || 1} totalPages={data.totalPages || 1} onPageChange={setPage} />
    </section>
  );
}
