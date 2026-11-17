import { useEffect, useRef, type RefObject } from "react";

export function ScrollStep({ listRef }: {
  listRef: RefObject<HTMLDivElement | null>;
}) {
  const badgeRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const list = listRef.current;
    const badge = badgeRef.current;
    if (!list || !badge) return;

    let frame = 0;
    let timer = 0;
    function update() {
      if (!list || !badge) return;
      frame = 0;
      const rect = list.getBoundingClientRect();
      const y = rect.top + list.clientHeight / 2;
      const hit = document.elementFromPoint(rect.left + list.clientWidth / 2, y);
      const row = hit?.closest<HTMLElement>("[data-scroll-step]");
      // Resolve the small gaps between rows at the same reading position.
      const next = row ?? document.elementFromPoint(
        rect.left + list.clientWidth / 2, y + 4,
      )?.closest<HTMLElement>("[data-scroll-step]");
      if (!next || !list.contains(next)) {
        badge.removeAttribute("data-visible");
        return;
      }
      badge.textContent = next.dataset.scrollStep ?? "";
      badge.style.top = `${list.offsetTop + list.clientHeight / 2}px`;
      badge.setAttribute("data-visible", "");
    }
    function onScroll() {
      if (!frame) frame = requestAnimationFrame(update);
      clearTimeout(timer);
      timer = window.setTimeout(() => badge?.removeAttribute("data-visible"), 650);
    }
    list.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      list.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [listRef]);

  return <span className="scroll-step" ref={badgeRef} aria-hidden="true" />;
}
