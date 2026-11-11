import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearProviderKey,
  KEY_STORAGE_KEY,
  readProviderKeys,
  saveProviderKey,
} from "../../src/chat/keys";
import type { Provider } from "../../src/chat/providers";

function memory(initial?: string) {
  const values = new Map<string, string>(
    initial === undefined ? [] : [[KEY_STORAGE_KEY, initial]],
  );
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    }),
  };
}
afterEach(() => vi.unstubAllGlobals());
describe("explicit local provider key storage", () => {
  it("persists a normalized opaque key and reads it after a fresh load", () => {
    const storage = memory();
    expect(saveProviderKey("gemini", "  AQ.synthetic-key_123  ", storage)).toBe(
      true,
    );
    expect(readProviderKeys(storage)).toEqual({
      gemini: "AQ.synthetic-key_123",
    });
    const reloaded = memory(storage.getItem(KEY_STORAGE_KEY)!);
    expect(readProviderKeys(reloaded)).toEqual({
      gemini: "AQ.synthetic-key_123",
    });
  });
  it("preserves the latest other-provider entries on every update", () => {
    const storage = memory();
    expect(saveProviderKey("openai", "synthetic-openai", storage)).toBe(true);
    // Model a second tab changing the record before this tab saves its own provider.
    storage.setItem(
      KEY_STORAGE_KEY,
      JSON.stringify({
        openai: "newer-synthetic-openai",
        anthropic: "synthetic-anthropic",
      }),
    );
    expect(saveProviderKey("gemini", "synthetic-gemini", storage)).toBe(true);
    expect(readProviderKeys(storage)).toEqual({
      openai: "newer-synthetic-openai",
      anthropic: "synthetic-anthropic",
      gemini: "synthetic-gemini",
    });
    expect(saveProviderKey("openai", "replacement-synthetic", storage)).toBe(
      true,
    );
    expect(readProviderKeys(storage).anthropic).toBe("synthetic-anthropic");
  });
  it("clears only the selected key and removes the record after the last key", () => {
    const storage = memory(
      JSON.stringify({ openai: "synthetic-a", gemini: "synthetic-b" }),
    );
    expect(clearProviderKey("openai", storage)).toBe(true);
    expect(readProviderKeys(storage)).toEqual({ gemini: "synthetic-b" });
    expect(storage.removeItem).not.toHaveBeenCalled();
    expect(clearProviderKey("gemini", storage)).toBe(true);
    expect(storage.getItem(KEY_STORAGE_KEY)).toBeNull();
    expect(storage.removeItem).toHaveBeenCalledWith(KEY_STORAGE_KEY);
  });
  it.each(["bad-json", "null", "[]", "42", '"synthetic"'])(
    "treats corrupt or non-object records as empty: %s",
    (raw) => {
      const storage = memory(raw);
      expect(readProviderKeys(storage)).toEqual({});
      expect(saveProviderKey("openai", "synthetic-valid", storage)).toBe(true);
      expect(readProviderKeys(storage)).toEqual({ openai: "synthetic-valid" });
    },
  );
  it("ignores unknown or malformed entries while retaining healthy providers", () => {
    const storage = memory(
      JSON.stringify({
        openai: " synthetic-valid ",
        gemini: { invalid: true },
        anthropic: "bad key",
        unknown: "ignored",
      }),
    );
    expect(readProviderKeys(storage)).toEqual({ openai: "synthetic-valid" });
    expect(saveProviderKey("gemini", "opaque-synthetic", storage)).toBe(true);
    expect(JSON.parse(storage.getItem(KEY_STORAGE_KEY)!)).toEqual({
      openai: "synthetic-valid",
      gemini: "opaque-synthetic",
    });
  });
  it.each([
    "",
    "   ",
    "bad key",
    "bad\nkey",
    "bad\tkey",
    "bad\u0000key",
    "bad\u007fkey",
    "bad\u0085key",
    "bad\u00a0key",
    "x".repeat(4097),
  ])("rejects invalid credentials without changing stored keys", (key) => {
    const storage = memory(JSON.stringify({ openai: "synthetic-existing" }));
    expect(saveProviderKey("gemini", key, storage)).toBe(false);
    expect(storage.getItem(KEY_STORAGE_KEY)).toBe(
      '{"openai":"synthetic-existing"}',
    );
    expect(storage.setItem).not.toHaveBeenCalled();
  });
  it("accepts the size boundary and makes no provider prefix assumptions", () => {
    const storage = memory();
    for (const [provider, key] of [
      ["openai", "opaque.synthetic+value/="],
      ["anthropic", "AQ.synthetic-value"],
      ["gemini", "x".repeat(4096)],
    ] as const) {
      expect(saveProviderKey(provider, key, storage)).toBe(true);
      expect(readProviderKeys(storage)[provider]).toBe(key);
    }
  });
  it("returns safe failures when reads, writes, or removal are blocked", () => {
    const blocked = () => {
      throw new Error("Synthetic storage failure");
    };
    const storage = memory();
    storage.getItem.mockImplementation(blocked);
    expect(readProviderKeys(storage)).toEqual({});
    expect(saveProviderKey("openai", "synthetic", storage)).toBe(false);
    expect(clearProviderKey("openai", storage)).toBe(false);
    expect(storage.setItem).not.toHaveBeenCalled();
    const writes = memory();
    writes.setItem.mockImplementation(blocked);
    expect(saveProviderKey("openai", "synthetic", writes)).toBe(false);
    const clearWrite = memory(
      JSON.stringify({
        gemini: "synthetic-other",
        openai: "synthetic-selected",
      }),
    );
    clearWrite.setItem.mockImplementation(blocked);
    expect(clearProviderKey("openai", clearWrite)).toBe(false);
    expect(readProviderKeys(clearWrite)).toEqual({
      gemini: "synthetic-other",
      openai: "synthetic-selected",
    });
    const removal = memory();
    removal.removeItem.mockImplementation(blocked);
    expect(clearProviderKey("openai", removal)).toBe(false);
  });
  it("rejects invalid runtime providers without writing a new property", () => {
    const storage = memory();
    expect(saveProviderKey("__proto__" as Provider, "synthetic", storage)).toBe(
      false,
    );
    expect(clearProviderKey("unknown" as Provider, storage)).toBe(false);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
  });
  it("uses guarded browser localStorage by default and tolerates unavailable storage", () => {
    const storage = memory();
    vi.stubGlobal("window", { localStorage: storage });
    expect(saveProviderKey("openai", "synthetic")).toBe(true);
    expect(readProviderKeys()).toEqual({ openai: "synthetic" });
    expect(clearProviderKey("openai")).toBe(true);
    vi.stubGlobal("window", {
      get localStorage() {
        throw new Error("Synthetic blocked browser storage");
      },
    });
    expect(readProviderKeys()).toEqual({});
    expect(saveProviderKey("openai", "synthetic")).toBe(false);
    expect(clearProviderKey("openai")).toBe(false);
    vi.stubGlobal("window", undefined);
    expect(readProviderKeys()).toEqual({});
    expect(saveProviderKey("openai", "synthetic")).toBe(false);
    expect(clearProviderKey("openai")).toBe(false);
  });
});
