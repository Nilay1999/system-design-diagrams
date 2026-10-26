import { useEffect, useState } from "react";

import { appStore } from "../../lib/storage";

export const SPLIT = { default: 42, min: 25, max: 70 } as const;

/** Width of the document pane in split view, as a percentage, remembered across visits. */
export function useSplitWidth() {
  const [width, setWidth] = useState(() => {
    const stored = Number(appStore.get("split"));
    return stored >= SPLIT.min && stored <= SPLIT.max ? stored : SPLIT.default;
  });
  useEffect(() => appStore.set("split", width.toFixed(1)), [width]);
  return [width, setWidth] as const;
}
