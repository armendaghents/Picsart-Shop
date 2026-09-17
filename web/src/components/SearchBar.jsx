import { useEffect, useRef, useState } from "react";
import { fetchSuggestions } from "../api";
import { useDebouncedValue } from "../hooks/useDebouncedValue";

export default function SearchBar({ t, query, onSearch, filtersOpen, onToggleFilters, activeFilterCount }) {
  const [draft, setDraft] = useState(query);
  const [suggestions, setSuggestions] = useState([]);
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(-1);
  const debouncedDraft = useDebouncedValue(draft, 150);
  const containerRef = useRef(null);

  useEffect(() => {
    setDraft(query);
  }, [query]);

  useEffect(() => {
    let cancelled = false;
    if (!debouncedDraft.trim()) {
      setSuggestions([]);
      return;
    }
    fetchSuggestions(debouncedDraft)
      .then((data) => {
        if (!cancelled) setSuggestions(data.items || []);
      })
      .catch(() => {
        if (!cancelled) setSuggestions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedDraft]);

  useEffect(() => {
    function handleClickOutside(event) {
      if (containerRef.current && !containerRef.current.contains(event.target)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  function runSearch(value) {
    onSearch(value);
    setOpen(false);
    setHighlighted(-1);
  }

  function handleKeyDown(event) {
    if (open && suggestions.length) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setHighlighted((index) => (index + 1) % suggestions.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setHighlighted((index) => (index <= 0 ? suggestions.length - 1 : index - 1));
        return;
      }
      if (event.key === "Tab" && highlighted >= 0) {
        event.preventDefault();
        runSearch(suggestions[highlighted].name);
        return;
      }
      if (event.key === "Escape") {
        setOpen(false);
        return;
      }
    }
    if (event.key === "Enter") {
      event.preventDefault();
      runSearch(highlighted >= 0 ? suggestions[highlighted].name : draft);
    }
  }

  return (
    <div className="search-with-filters" ref={containerRef}>
      <div className="search-console shop-search">
        <div className="search-box">
          <span className="search-icon">⌕</span>
          <input
            type="text"
            autoComplete="off"
            placeholder={t.searchPlaceholder}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setOpen(true);
              setHighlighted(-1);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={handleKeyDown}
            autoFocus
          />
          {draft && (
            <button
              className="icon-button subtle"
              type="button"
              title={t.clearSearch}
              onClick={() => {
                setDraft("");
                runSearch("");
              }}
            >
              ×
            </button>
          )}
          <button className="search-submit" type="button" title={t.search} onClick={() => runSearch(draft)}>
            ⌕
          </button>
        </div>

        {open && suggestions.length > 0 && (
          <ul className="search-suggestions" role="listbox">
            {suggestions.map((item, index) => (
              <li
                key={item.id}
                role="option"
                aria-selected={index === highlighted}
                className={index === highlighted ? "search-suggestion-active" : ""}
                onMouseEnter={() => setHighlighted(index)}
                onMouseDown={(event) => {
                  event.preventDefault();
                  runSearch(item.name);
                }}
              >
                <span className="search-suggestion-icon">{item.icon}</span>
                <span className="search-suggestion-name">{item.name}</span>
                <span className="search-suggestion-category">{item.category}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <button
        className={`filters-toggle${activeFilterCount ? " filters-toggle-active" : ""}`}
        type="button"
        onClick={onToggleFilters}
        aria-expanded={filtersOpen}
      >
        <span>⚙</span>
        <span>{t.filters}</span>
        {activeFilterCount > 0 && <span className="filters-badge">{activeFilterCount}</span>}
      </button>
    </div>
  );
}
