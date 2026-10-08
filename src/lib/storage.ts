/**
 * Safe access to `localStorage`. Every call can fail (private windows, blocked site data,
 * quota exceeded), and the app must keep working when it does, so failures are swallowed
 * and reads fall back to `null`.
 */

export interface KeyValueStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
  getJSON<T>(key: string): T | null;
  setJSON(key: string, value: unknown): void;
}

function attempt<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** A store whose keys are all prefixed with `<namespace>:`. */
export function createStore(namespace: string, backend: () => Storage = () => window.localStorage): KeyValueStore {
  const k = (key: string) => `${namespace}:${key}`;
  const store: KeyValueStore = {
    get: (key) => attempt(() => backend().getItem(k(key)), null),
    set: (key, value) => attempt(() => backend().setItem(k(key), value), undefined),
    remove: (key) => attempt(() => backend().removeItem(k(key)), undefined),
    getJSON: <T>(key: string) => {
      const raw = store.get(key);
      return raw === null ? null : attempt(() => JSON.parse(raw) as T, null);
    },
    setJSON: (key, value) => store.set(key, JSON.stringify(value)),
  };
  return store;
}

/** The app's own namespace. Keys predate this module, so they must not change. */
export const appStore = createStore("sdd");
