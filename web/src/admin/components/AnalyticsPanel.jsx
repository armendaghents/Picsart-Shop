import { useEffect, useState } from "react";
import { fetchOrderSummary, fetchOrdersForDay } from "../api";

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const formatMoney = (amount) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(amount || 0);

function pad(n) {
  return String(n).padStart(2, "0");
}

function toDateKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function toMonthKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
}

function monthLabel(date) {
  return date.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

// ordered_at is stored as a UTC "YYYY-MM-DD HH:MM:SS" string.
function formatTime(timestamp) {
  const date = new Date(`${timestamp.replace(" ", "T")}Z`);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export default function AnalyticsPanel() {
  const [monthCursor, setMonthCursor] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [days, setDays] = useState({});
  const [selectedDate, setSelectedDate] = useState(null);
  const [dayOrders, setDayOrders] = useState([]);
  const [loadingDay, setLoadingDay] = useState(false);

  useEffect(() => {
    fetchOrderSummary(toMonthKey(monthCursor))
      .then((data) => setDays(data.days || {}))
      .catch((error) => console.error("Order summary load failed", error));
    setSelectedDate(null);
    setDayOrders([]);
  }, [monthCursor]);

  useEffect(() => {
    if (!selectedDate) return;
    setLoadingDay(true);
    fetchOrdersForDay(selectedDate)
      .then((data) => setDayOrders(data.orders || []))
      .catch((error) => console.error("Day orders load failed", error))
      .finally(() => setLoadingDay(false));
  }, [selectedDate]);

  const startWeekday = monthCursor.getDay();
  const daysInMonth = new Date(monthCursor.getFullYear(), monthCursor.getMonth() + 1, 0).getDate();
  const todayKey = toDateKey(new Date());

  const cells = Array(startWeekday).fill(null);
  for (let day = 1; day <= daysInMonth; day++) {
    cells.push(new Date(monthCursor.getFullYear(), monthCursor.getMonth(), day));
  }

  function changeMonth(delta) {
    setMonthCursor((current) => new Date(current.getFullYear(), current.getMonth() + delta, 1));
  }

  return (
    <section className="analytics-panel" aria-label="Order analytics">
      <div className="analytics-head">
        <h2>Order Analytics</h2>
        <div className="analytics-month-nav">
          <button type="button" className="icon-button subtle" onClick={() => changeMonth(-1)} aria-label="Previous month">
            ‹
          </button>
          <strong>{monthLabel(monthCursor)}</strong>
          <button type="button" className="icon-button subtle" onClick={() => changeMonth(1)} aria-label="Next month">
            ›
          </button>
        </div>
      </div>

      <div className="analytics-grid">
        <div className="calendar">
          <div className="calendar-weekdays">
            {WEEKDAY_LABELS.map((label) => (
              <span key={label}>{label}</span>
            ))}
          </div>
          <div className="calendar-days">
            {cells.map((date, index) => {
              if (!date) return <span key={`empty-${index}`} className="calendar-cell calendar-cell-empty" />;
              const key = toDateKey(date);
              const count = days[key] || 0;
              const hasOrders = count > 0;
              return (
                <button
                  type="button"
                  key={key}
                  className={`calendar-cell${hasOrders ? " calendar-cell-has-orders" : ""}${key === todayKey ? " calendar-cell-today" : ""}${key === selectedDate ? " calendar-cell-selected" : ""}`}
                  onClick={() => hasOrders && setSelectedDate(key)}
                  disabled={!hasOrders}
                >
                  <span className="calendar-cell-day">{date.getDate()}</span>
                  {hasOrders && <span className="calendar-cell-count">{count}</span>}
                </button>
              );
            })}
          </div>
        </div>

        <div className="calendar-detail">
          {!selectedDate ? (
            <p className="empty-state">Click a highlighted day to see its orders.</p>
          ) : loadingDay ? (
            <p className="empty-state">Loading…</p>
          ) : (
            <>
              <h3>{selectedDate}</h3>
              {dayOrders.length ? (
                <ul className="order-list">
                  {dayOrders.map((order) => (
                    <li key={order.id} className="order-list-item">
                      <div className="order-list-main">
                        <strong>{order.name}</strong>
                        <span>{[order.brand, order.model].filter(Boolean).join(" · ") || "—"}</span>
                      </div>
                      <div className="order-list-meta">
                        <span>{order.sku}</span>
                        {order.category && (
                          <span>{order.category.split(">").map((part) => part.trim()).at(-1)}</span>
                        )}
                        {order.quantity > 1 && <span>×{order.quantity}</span>}
                        <span>{formatMoney(order.price)}</span>
                        <span>{formatTime(order.orderedAt)}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="empty-state">No orders that day.</p>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
