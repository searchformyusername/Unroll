export const APPEARANCE_STORAGE_KEY = "unroll-appearance";
export const PALETTES = [
  { id: "lavender", label: "Lavender", color: "#c5b3df" },
  { id: "sand", label: "Sand", color: "#ddc78a" },
  { id: "paper", label: "Paper", color: "#f1f1f1" },
  { id: "sage", label: "Sage", color: "#acc49d" },
  { id: "sky", label: "Sky", color: "#a7c5de" },
] as const;
export type Palette = (typeof PALETTES)[number]["id"];
export type ColorMode = "light" | "dark";
export interface AppearancePreferences {
  mode: ColorMode;
  palette: Palette;
}
export const DEFAULT_APPEARANCE: Readonly<AppearancePreferences> = {
  mode: "dark",
  palette: "sky",
};
type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;

/** Persisted values are untrusted. Recover valid fields independently. */
export function validateAppearance(value: unknown): AppearancePreferences {
  const item =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    mode:
      item.mode === "dark" || item.mode === "light"
        ? item.mode
        : DEFAULT_APPEARANCE.mode,
    palette: PALETTES.some((palette) => palette.id === item.palette)
      ? (item.palette as Palette)
      : DEFAULT_APPEARANCE.palette,
  };
}
function browserStorage(): PreferenceStorage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}
export function readAppearance(
  storage: Pick<PreferenceStorage, "getItem"> | undefined = browserStorage(),
): AppearancePreferences {
  try {
    const raw = storage?.getItem(APPEARANCE_STORAGE_KEY);
    return raw
      ? validateAppearance(JSON.parse(raw))
      : { ...DEFAULT_APPEARANCE };
  } catch {
    return { ...DEFAULT_APPEARANCE };
  }
}
/** A false return means preferences apply for this tab but could not be saved. */
export function saveAppearance(
  value: AppearancePreferences,
  storage: Pick<PreferenceStorage, "setItem"> | undefined = browserStorage(),
): boolean {
  try {
    if (!storage) return false;
    storage.setItem(
      APPEARANCE_STORAGE_KEY,
      JSON.stringify(validateAppearance(value)),
    );
    return true;
  } catch {
    return false;
  }
}
export function applyAppearance(
  value: AppearancePreferences,
  root?: Pick<HTMLElement, "setAttribute">,
): void {
  const target =
    root ??
    (typeof document === "undefined" ? undefined : document.documentElement);
  const safe = validateAppearance(value);
  target?.setAttribute("data-mode", safe.mode);
  target?.setAttribute("data-palette", safe.palette);
}
