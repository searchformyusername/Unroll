import { describe, expect, it } from "vitest";
import {
  anchoredScrollTop,
  anchorAfterClick,
  nextEventBatch,
} from "../src/navigation";
const base = {
  scrollTop: 0,
  viewportHeight: 600,
  scrollHeight: 6000,
  itemTop: 100,
  itemHeight: 54,
  direction: "down" as const,
};
describe("context-preserving keyboard navigation", () => {
  it("does not move the list while a downward selection is above the middle", () =>
    expect(anchoredScrollTop(base)).toBe(0));
  it("moves the content up once the next row crosses the middle anchor", () =>
    expect(anchoredScrollTop({ ...base, itemTop: 400 })).toBe(139));
  it("retains following events by anchoring rather than pinning selection to the bottom", () => {
    const top = anchoredScrollTop({ ...base, scrollTop: 180, itemTop: 700 });
    expect(700 - top + 27).toBe(288);
    expect(600 - (700 - top + 54)).toBeGreaterThan(250);
  });
  it("anchors upward movement and clamps at the start", () => {
    expect(
      anchoredScrollTop({
        ...base,
        scrollTop: 500,
        itemTop: 600,
        direction: "up",
      }),
    ).toBe(339);
    expect(
      anchoredScrollTop({
        ...base,
        scrollTop: 100,
        itemTop: 0,
        direction: "up",
      }),
    ).toBe(0);
  });
  it("never scrolls beyond the end or centers deep inside a very tall event", () => {
    expect(anchoredScrollTop({ ...base, itemTop: 5900 })).toBe(5400);
    expect(anchoredScrollTop({ ...base, itemTop: 500, itemHeight: 5000 })).toBe(
      362,
    );
  });
  it("handles an empty or shorter list", () => {
    expect(anchoredScrollTop({ ...base, viewportHeight: 0 })).toBe(0);
    expect(
      anchoredScrollTop({ ...base, scrollHeight: 400, itemTop: 380 }),
    ).toBe(0);
  });
});
describe("automatic event batches", () => {
  it("loads a complete next batch and clamps the final partial batch", () => {
    expect(nextEventBatch(100, 1000)).toBe(200);
    expect(nextEventBatch(100, 138)).toBe(138);
    expect(nextEventBatch(138, 138)).toBe(138);
  });
});

describe("clicked navigation position", () => {
  it("keeps a lower clicked row at its chosen height instead of centering it", () => {
    const anchor = anchorAfterClick(0.8, "down");
    expect(anchor).toBe(0.8);
    expect(
      anchoredScrollTop({
        ...base,
        scrollTop: 500,
        itemTop: 1007,
        anchorRatio: anchor,
      }),
    ).toBe(554);
  });
  it("preserves middle clicks and lets upper downward reading reach the middle naturally", () => {
    expect(anchorAfterClick(0.55, "down")).toBe(0.55);
    expect(anchorAfterClick(0.2, "down")).toBe(0.48);
    expect(anchorAfterClick(0.2, "up")).toBe(0.2);
  });
});
