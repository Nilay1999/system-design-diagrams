import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Excalidraw reads process.env.IS_PREACT at runtime.
  define: {
    "process.env.IS_PREACT": JSON.stringify("false"),
  },
  // Same-origin /api in dev, like the Vercel rewrite in production. Run the API with
  // `cd server && go run ./cmd/server api`.
  server: {
    proxy: {
      "/api": process.env.API_ORIGIN ?? "http://localhost:8080",
    },
  },
  build: {
    // Excalidraw ships a few large chunks of its own; they are lazy-loaded.
    chunkSizeWarningLimit: 2500,
  },
});
