import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  // Relative asset paths so the built index.html works when loaded from
  // `file://` inside Electron. Harmless for the same-origin web build.
  base: "./",
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    // Split large third-party libs into their own long-term-cacheable chunks
    // instead of one giant vendor blob. The editor chunk is only pulled in by
    // the lazily loaded SQL IDE route; sql-formatter and dt-sql-parser are
    // dynamically imported on first use.
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom", "react-router-dom"],
          query: ["@tanstack/react-query", "@tanstack/react-virtual"],
          codemirror: [
            "@codemirror/view",
            "@codemirror/state",
            "@codemirror/language",
            "@codemirror/lang-sql",
            "@codemirror/autocomplete",
            "@codemirror/commands",
            "@codemirror/search",
            "@codemirror/lint",
            "@lezer/highlight",
          ],
        },
      },
    },
    // The two lazily loaded SQL grammars (PostgreSQL, MySQL) are ~1.8 MB each.
    chunkSizeWarningLimit: 2000,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8000",
        changeOrigin: true,
      },
    },
  },
});
