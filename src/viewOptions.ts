export const VIEW_OPTIONS_KEY = "unroll-view-options-v1";
export interface ViewOptions {
  showUsage: boolean;
  showBranches: boolean;
}
function browserStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}
export function readViewOptions(
  storage: Pick<Storage, "getItem"> | undefined = browserStorage(),
): ViewOptions {
  const defaults = { showUsage: false, showBranches: false };
  try {
    const value = JSON.parse(storage?.getItem(VIEW_OPTIONS_KEY) || "null");
    if (!value || typeof value !== "object" || Array.isArray(value))
      return defaults;
    return {
      showUsage: value.showUsage === true,
      showBranches: value.showBranches === true,
    };
  } catch {
    return defaults;
  }
}
export function saveViewOptions(
  value: ViewOptions,
  storage: Pick<Storage, "setItem"> | undefined = browserStorage(),
): boolean {
  try {
    if (!storage) return false;
    storage.setItem(
      VIEW_OPTIONS_KEY,
      JSON.stringify({
        showUsage: value.showUsage,
        showBranches: value.showBranches,
      }),
    );
    return true;
  } catch {
    return false;
  }
}
