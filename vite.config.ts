import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Excalidraw reads process.env.IS_PREACT at runtime.
  define: {
    "process.env.IS_PREACT": JSON.stringify("false"),
  },
  build: {
    // Excalidraw ships a few large chunks of its own; they are lazy-loaded.
    chunkSizeWarningLimit: 2500,
  },
});
