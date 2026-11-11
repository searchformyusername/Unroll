import type { Provider } from "./providers";

export const KEY_STORAGE_KEY = "unroll-provider-keys-v1";
type ProviderKeys = Partial<Record<Provider, string>>;
type ReadStorage = Pick<Storage, "getItem">;
type WriteStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const PROVIDERS: Provider[] = ["anthropic", "openai", "gemini"];

function browserStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}
function normalize(key: unknown): string | undefined {
  if (typeof key !== "string") return undefined;
  const trimmed = key.trim();
  return trimmed &&
    trimmed.length <= 4096 &&
    !/[\s\u0000-\u001f\u007f-\u009f]/.test(trimmed)
    ? trimmed
    : undefined;
}
function decode(raw: string | null): ProviderKeys {
  if (raw === null) return {};
  let record: unknown;
  try {
    record = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof record !== "object" || record === null || Array.isArray(record))
    return {};
  const keys: ProviderKeys = {};
  for (const provider of PROVIDERS) {
    if (!Object.prototype.hasOwnProperty.call(record, provider)) continue;
    const key = normalize((record as Record<string, unknown>)[provider]);
    if (key !== undefined) keys[provider] = key;
  }
  return keys;
}

/** Read only known, valid provider entries; inaccessible browser storage is empty. */
export function readProviderKeys(
  storage: ReadStorage | undefined = browserStorage(),
): ProviderKeys {
  try {
    return storage ? decode(storage.getItem(KEY_STORAGE_KEY)) : {};
  } catch {
    return {};
  }
}

/** Read the latest record before changing one entry, preserving other providers. */
export function saveProviderKey(
  provider: Provider,
  key: string,
  storage: WriteStorage | undefined = browserStorage(),
): boolean {
  const normalized = normalize(key);
  if (!storage || !PROVIDERS.includes(provider) || normalized === undefined)
    return false;
  try {
    const keys = decode(storage.getItem(KEY_STORAGE_KEY));
    keys[provider] = normalized;
    storage.setItem(KEY_STORAGE_KEY, JSON.stringify(keys));
    return true;
  } catch {
    return false;
  }
}

/** Clear just one provider; leave no storage record when there are no keys left. */
export function clearProviderKey(
  provider: Provider,
  storage: WriteStorage | undefined = browserStorage(),
): boolean {
  if (!storage || !PROVIDERS.includes(provider)) return false;
  try {
    const keys = decode(storage.getItem(KEY_STORAGE_KEY));
    delete keys[provider];
    if (Object.keys(keys).length)
      storage.setItem(KEY_STORAGE_KEY, JSON.stringify(keys));
    else storage.removeItem(KEY_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}
