import { createContext, useContext } from "react";

import type { Track } from "./types";

export const TrackContext = createContext<Track | null>(null);

/** The track of the current route. Every page renders inside a `TrackRoute`. */
export function useTrack(): Track {
  const value = useContext(TrackContext);
  if (!value) throw new Error("useTrack must be used inside <TrackRoute>");
  return value;
}
