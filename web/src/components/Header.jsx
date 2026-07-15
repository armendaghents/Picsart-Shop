import { LANGUAGES } from "../i18n";

export default function Header({ t, lang, onLangChange, currency, onCurrencyChange, dark, onToggleDark, onHome, searchSlot, compact }) {
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
        <span className="brand-mark">A</span>
        <div className="brand-copy">
          <strong>Atlas</strong>
          <span>{t.tagline}</span>
        </div>
      </a>

      <div className="app-header-search">{searchSlot}</div>

      <div className="top-actions">
        <select
          className="lang-select"
          aria-label="Currency"
          title="Currency"
          value={currency}
          onChange={(event) => onCurrencyChange(event.target.value)}
        >
          <option value="USD">USD $</option>
          <option value="AMD">AMD ֏</option>
          <option value="RUB">RUB ₽</option>
        </select>

        <select
          className="lang-select"
          aria-label="Language"
          title="Language"
          value={lang}
          onChange={(event) => onLangChange(event.target.value)}
        >
          {LANGUAGES.map((language) => (
            <option key={language.code} value={language.code}>
              {language.flag} {language.label}
            </option>
          ))}
        </select>

        <button className="icon-button" type="button" title="Toggle theme" onClick={onToggleDark}>
          {dark ? "☀" : "◐"}
        </button>
      </div>
    </header>
  );
}
