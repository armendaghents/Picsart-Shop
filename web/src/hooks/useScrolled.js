import { useEffect, useState } from "react";

/**
 * Whether the page has been scrolled far enough to compact the header.
 *
 * Two thresholds, not one. The header is what reacts to this value, and
 * compacting it makes it shorter — which shortens the document, which makes the
 * browser reduce scrollY. With a single threshold that reduction can drop the
 * page back below it, expanding the header, restoring the height, and crossing
 * the threshold again: the header then oscillates forever at one scroll
 * position, visible as the search field sliding left and right.
 *
 * Widening the gap breaks the cycle. Compacting starts at `enterPx`, but
 * expanding again needs `leavePx` — which defaults to the very top of the page,
 * where there is no room left for a height change to push scrollY down.
 */
export function useScrolled(enterPx = 12, leavePx = 0) {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    // Read from the previous value rather than from `scrolled`: this listener
    // is registered once, so a captured value would be the one from mount.
    const onScroll = () =>
      setScrolled((wasScrolled) => (wasScrolled ? window.scrollY > leavePx : window.scrollY > enterPx));

    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [enterPx, leavePx]);

  return scrolled;
}
