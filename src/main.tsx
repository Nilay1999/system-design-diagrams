import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import "./styles.css";

// Serve Excalidraw fonts from /fonts (copied by scripts/copy-excalidraw-assets.mjs)
// before falling back to its CDN.
window.EXCALIDRAW_ASSET_PATH = new URL(import.meta.env.BASE_URL, window.location.origin).href;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
