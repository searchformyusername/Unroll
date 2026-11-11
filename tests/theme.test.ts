import { describe, expect, it } from "vitest";
import {
  APPEARANCE_STORAGE_KEY,
  DEFAULT_APPEARANCE,
  PALETTES,
  applyAppearance,
  readAppearance,
  saveAppearance,
  validateAppearance,
} from "../src/theme";

describe("appearance preferences", () => {
  it("offers exactly five stable palettes without changing the default", () => {
    expect(PALETTES.map((p) => p.id)).toEqual([
      "lavender",
      "sand",
      "paper",
      "sage",
      "sky",
    ]);
    expect(readAppearance({ getItem: () => null })).toEqual(DEFAULT_APPEARANCE);
  });
  it("round-trips all ten supported mode/palette combinations", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
    for (const mode of ["light", "dark"] as const)
      for (const palette of PALETTES) {
        const prefs = { mode, palette: palette.id };
        expect(saveAppearance(prefs, storage)).toBe(true);
        expect(readAppearance(storage)).toEqual(prefs);
        expect(JSON.parse(values.get(APPEARANCE_STORAGE_KEY)!)).toEqual(prefs);
      }
  });
  it("recovers valid fields independently and drops unknown fields", () => {
    expect(
      validateAppearance({
        mode: "dark",
        palette: "obsolete",
        token: "must-not-persist",
      }),
    ).toEqual({ mode: "dark", palette: "lavender" });
    expect(validateAppearance({ mode: "system", palette: "sage" })).toEqual({
      mode: "light",
      palette: "sage",
    });
    for (const value of [null, false, "dark", [], 10, {}])
      expect(validateAppearance(value)).toEqual(DEFAULT_APPEARANCE);
    expect(
      validateAppearance({ mode: "<script>", palette: "__proto__" }),
    ).toEqual(DEFAULT_APPEARANCE);
  });
  it("uses a safe default for corrupted or inaccessible storage", () => {
    expect(readAppearance({ getItem: () => "{broken" })).toEqual(
      DEFAULT_APPEARANCE,
    );
    expect(
      readAppearance({
        getItem: () => {
          throw new Error("Storage denied");
        },
      }),
    ).toEqual(DEFAULT_APPEARANCE);
    expect(
      saveAppearance(
        { mode: "dark", palette: "sand" },
        {
          setItem: () => {
            throw new Error("Quota exceeded");
          },
        },
      ),
    ).toBe(false);
  });
  it("only persists validated display settings", () => {
    let saved = "";
    saveAppearance(
      { mode: "invalid", palette: "sky", secret: "do not save" } as never,
      {
        setItem: (_key, value) => {
          saved = value;
        },
      },
    );
    expect(JSON.parse(saved)).toEqual({ mode: "light", palette: "sky" });
  });
  it("applies only validated root attributes, including night mode", () => {
    const attributes = new Map<string, string>();
    const root = {
      setAttribute: (name: string, value: string) => {
        attributes.set(name, value);
      },
    };
    applyAppearance({ mode: "dark", palette: "paper" }, root);
    expect([...attributes]).toEqual([
      ["data-mode", "dark"],
      ["data-palette", "paper"],
    ]);
    applyAppearance({ mode: "unknown", palette: "arbitrary" } as never, root);
    expect(attributes.get("data-mode")).toBe("light");
    expect(attributes.get("data-palette")).toBe("lavender");
  });
  it("does not fail in a non-browser environment", () => {
    expect(() =>
      applyAppearance({ mode: "dark", palette: "sky" }),
    ).not.toThrow();
    expect(readAppearance()).toEqual(DEFAULT_APPEARANCE);
    expect(saveAppearance({ mode: "light", palette: "paper" })).toBe(false);
  });
});

describe("theme contrast", () => {
  it("keeps reading text and semantic icons legible in all ten appearances", async () => {
    const fileSystemModule: string = "node:fs";
    const {
      readFileSync,
    }: { readFileSync(path: URL, encoding: "utf8"): string } = await import(
      fileSystemModule
    );
    const css = readFileSync(
      new URL("../src/theme.css", import.meta.url),
      "utf8",
    );
    const properties = (selector: string): Record<string, string> => {
      const start = css.indexOf(selector + " {");
      expect(start, selector).toBeGreaterThanOrEqual(0);
      const block = css.slice(start, css.indexOf("}", start));
      return Object.fromEntries(
        [...block.matchAll(/(--[\w-]+)\s*:\s*(#[a-fA-F0-9]{6})/g)].map(
          (match) => [match[1], match[2]],
        ),
      );
    };
    const luminance = (hex: string) => {
      const values = [1, 3, 5]
        .map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255)
        .map((value) =>
          value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
        );
      return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
    };
    const ratio = (a: string, b: string) => {
      const values = [luminance(a), luminance(b)].sort((x, y) => x - y);
      return (values[1] + 0.05) / (values[0] + 0.05);
    };
    for (const mode of ["light", "dark"])
      for (const palette of PALETTES) {
        const tokens = { ...properties(":root[data-mode][data-palette]") };
        if (palette.id !== "lavender")
          Object.assign(
            tokens,
            properties(`:root[data-mode][data-palette="${palette.id}"]`),
          );
        if (mode === "dark") {
          Object.assign(
            tokens,
            properties(':root[data-mode="dark"][data-palette]'),
          );
          if (palette.id !== "lavender")
            Object.assign(
              tokens,
              properties(
                `:root[data-mode="dark"][data-palette="${palette.id}"]`,
              ),
            );
        }
        for (const foreground of ["--theme-text", "--theme-muted"])
          for (const background of [
            "--theme-reader",
            "--theme-selection",
            "--theme-raised",
          ]) {
            expect(
              ratio(tokens[foreground], tokens[background]),
              `${mode}/${palette.id}: ${foreground} on ${background}`,
            ).toBeGreaterThanOrEqual(4.5);
          }
        for (const foreground of Object.keys(tokens).filter((key) =>
          key.startsWith("--theme-icon-"),
        )) {
          expect(
            ratio(tokens[foreground], tokens["--theme-raised"]),
            `${mode}/${palette.id}: ${foreground}`,
          ).toBeGreaterThanOrEqual(3);
        }
      }
  });
});
