import { LANGUAGES } from "../i18n";

const CURRENCY_SYMBOLS = { USD: "$", AMD: "֏", RUB: "₽", EUR: "€", GBP: "£" };

export default function Header({
  t,
  lang,
  onLangChange,
  currency,
  currencies = ["USD"],
  onCurrencyChange,
  dark,
  onToggleDark,
  onHome,
  searchSlot,
  compact,
  user,
  cartCount,
  onOpenCart,
  onSignIn,
  onSignOut,
  onOpenAccount,
}) {
  return (
    <header className={`app-header${compact ? " app-header-compact" : ""}`}>
      <a
        className="brand"
        href="#"
        onClick={(event) => {
          event.preventDefault();
          onHome();
        }}
      >
        <img className="brand-mark" src="/picsart-logo.jpeg" alt="Picsart" />
        <div className="brand-copy">
          <strong>Picsart Shop</strong>
          <span>{t.tagline}</span>
        </div>
      </a>

      <div className="app-header-search">{searchSlot}</div>

      <div className="top-actions">
        <select
          className="lang-select"
          aria-label={t.currencyLabel}
          title={t.currencyLabel}
          value={currency}
          onChange={(event) => onCurrencyChange(event.target.value)}
        >
          {/* Only what the server has a rate for. A currency with no rate
              cannot be converted, and offering it would show prices that are
              simply the USD number with the wrong symbol on it. */}
          {currencies.map((code) => (
            <option key={code} value={code}>
              {code} {CURRENCY_SYMBOLS[code] || ""}
            </option>
          ))}
        </select>

        <select
          className="lang-select"
          aria-label={t.languageLabel}
          title={t.languageLabel}
          value={lang}
          onChange={(event) => onLangChange(event.target.value)}
        >
          {LANGUAGES.map((language) => (
            <option key={language.code} value={language.code}>
              {language.flag} {language.label}
            </option>
          ))}
        </select>

        <button className="icon-button" type="button" title={t.toggleTheme} onClick={onToggleDark}>
          {dark ? "☀" : "◐"}
        </button>

        <button className="icon-button cart-button" type="button" title={t.basket} onClick={onOpenCart}>
          <span aria-hidden="true">🧺</span>
          {cartCount > 0 && <span className="cart-badge">{cartCount}</span>}
          <span className="sr-only">{t.basket}</span>
        </button>

        {user ? (
          <div className="account-menu">
            <button className="account-chip" type="button" title={t.myAccount} onClick={onOpenAccount}>
              {(user.name || user.email).slice(0, 1).toUpperCase()}
            </button>
            <button className="text-button" type="button" onClick={onSignOut}>
              {t.signOut}
            </button>
          </div>
        ) : (
          <button className="text-button" type="button" onClick={onSignIn}>
            {t.signIn}
          </button>
        )}
      </div>
    </header>
  );
}
