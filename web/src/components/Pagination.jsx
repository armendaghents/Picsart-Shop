function pageNumbers(current, total) {
  const delta = 2;
  const pages = [];
  for (let i = 1; i <= total; i++) {
    if (i === 1 || i === total || (i >= current - delta && i <= current + delta)) {
      pages.push(i);
    }
  }

  const withDots = [];
  let previous;
  for (const page of pages) {
    if (previous !== undefined) {
      if (page - previous === 2) withDots.push(previous + 1);
      else if (page - previous > 2) withDots.push("…");
    }
    withDots.push(page);
    previous = page;
  }
  return withDots;
}

export default function Pagination({ t, page, totalPages, onPageChange }) {
  if (totalPages <= 1) return null;

  return (
    <nav className="pagination" aria-label={t.pagination}>
      <button
        type="button"
        className="pagination-nav"
        onClick={() => onPageChange(page - 1)}
        disabled={page <= 1}
        aria-label={t.previousPage}
      >
        ‹
      </button>

      {pageNumbers(page, totalPages).map((entry, index) =>
        entry === "…" ? (
          <span className="pagination-dots" key={`dots-${index}`}>
            …
          </span>
        ) : (
          <button
            type="button"
            key={entry}
            className={`pagination-page${entry === page ? " pagination-page-active" : ""}`}
            onClick={() => onPageChange(entry)}
            aria-current={entry === page ? "page" : undefined}
          >
            {entry}
          </button>
        )
      )}

      <button
        type="button"
        className="pagination-nav"
        onClick={() => onPageChange(page + 1)}
        disabled={page >= totalPages}
        aria-label={t.nextPage}
      >
        ›
      </button>
    </nav>
  );
}
