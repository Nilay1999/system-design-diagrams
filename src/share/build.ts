import { TRACKS } from "../tracks";
import { sharePages } from "./pages";

/** Entry point for build scripts (loaded with Vite's runnerImport, so doc imports resolve). */
export const allSharePages = () => sharePages(TRACKS);
export { TRACKS };
export * from "./pages";
