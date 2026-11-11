export type Direction = "up" | "down";

/** Keep keyboard selection around the middle once it reaches that part of the list. */
export function anchoredScrollTop({
  scrollTop,
  viewportHeight,
  scrollHeight,
  itemTop,
  itemHeight,
  direction,
}: {
  scrollTop: number;
  viewportHeight: number;
  scrollHeight: number;
  itemTop: number;
  itemHeight: number;
  direction: Direction;
}): number {
  if (viewportHeight <= 0) return scrollTop;
  const anchor = viewportHeight * 0.48;
  // An expanded event may be taller than the list; keep its beginning in view.
  const focusPoint = itemTop + Math.min(itemHeight, viewportHeight * 0.5) / 2;
  const desired = focusPoint - anchor;
  const directed =
    direction === "down"
      ? Math.max(scrollTop, desired)
      : Math.min(scrollTop, desired);
  return Math.max(
    0,
    Math.min(Math.max(0, scrollHeight - viewportHeight), directed),
  );
}
export const BATCH_SIZE = 100;
export const PREFETCH_EVENTS = 20;
export function nextEventBatch(rendered: number, total: number): number {
  return Math.min(total, rendered + BATCH_SIZE);
}
