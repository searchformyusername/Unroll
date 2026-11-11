import { describe, expect, it } from "vitest";
import {
  readViewOptions,
  saveViewOptions,
  VIEW_OPTIONS_KEY,
} from "../src/viewOptions";
describe("saved view options", () => {
  it("restores all four checkbox combinations, including explicit false", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) || null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
    for (const showUsage of [true, false])
      for (const showBranches of [true, false]) {
        expect(saveViewOptions({ showUsage, showBranches }, storage)).toBe(
          true,
        );
        expect(readViewOptions(storage)).toEqual({ showUsage, showBranches });
        expect([...values.keys()]).toEqual([VIEW_OPTIONS_KEY]);
      }
  });
  it("keeps valid booleans independently without treating strings as checked", () => {
    expect(
      readViewOptions({
        getItem: () =>
          '{"showUsage":true,"showBranches":"true","extra":"ignore"}',
      }),
    ).toEqual({ showUsage: true, showBranches: false });
    expect(
      readViewOptions({ getItem: () => '{"showUsage":1,"showBranches":true}' }),
    ).toEqual({ showUsage: false, showBranches: true });
  });
  it("falls back safely for missing, malformed, or inaccessible storage", () => {
    for (const value of [null, "{broken", "[]", "true", '"text"'])
      expect(readViewOptions({ getItem: () => value })).toEqual({
        showUsage: false,
        showBranches: false,
      });
    expect(
      readViewOptions({
        getItem: () => {
          throw new Error("Blocked");
        },
      }),
    ).toEqual({ showUsage: false, showBranches: false });
    expect(
      saveViewOptions(
        { showUsage: true, showBranches: true },
        {
          setItem: () => {
            throw new Error("Quota");
          },
        },
      ),
    ).toBe(false);
  });
});
