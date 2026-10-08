import { useEffect, useState } from "react";

import { appStore } from "../lib/storage";

/**
 * State limited to a fixed set of values and remembered across visits. Stored values that are no
 * longer allowed are ignored. `initial` runs once and can look at the URL or the viewport.
 */
export function usePreference<T extends string>(key: string, allowed: readonly T[], initial: () => T) {
  const [value, setValue] = useState<T>(() => {
    const stored = appStore.get(key) as T | null;
    return stored !== null && allowed.includes(stored) ? stored : initial();
  });
  useEffect(() => appStore.set(key, value), [key, value]);
  return [value, setValue] as const;
}
