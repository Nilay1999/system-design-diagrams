import { useLayoutEffect } from "react";
import { Outlet } from "react-router";

import { TrackContext } from "./context";
import type { Track } from "./types";

/** Layout route for one track: provides it to the pages below and applies its theme. */
export function TrackRoute({ track }: { track: Track }) {
  // Layout effect, so the page never paints with the previous track's colours.
  useLayoutEffect(() => {
    document.documentElement.dataset.track = track.id;
  }, [track]);

  return (
    <TrackContext.Provider value={track}>
      <Outlet />
    </TrackContext.Provider>
  );
}
