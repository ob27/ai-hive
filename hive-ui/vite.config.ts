import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The host serves the built screen at /hive/ and the data at /hive/state and /hive/stream. In dev, Vite serves the
// screen and proxies those two data routes to a running host (default the screen port, 3100; set HIVE_HOST to change).
const host = process.env.HIVE_HOST ?? "http://localhost:3100";
const app = (p: string) => fileURLToPath(new URL(`./node_modules/${p}`, import.meta.url));

export default defineConfig({
  base: "/hive/",
  plugins: [react()],
  resolve: {
    // rebar-ui is linked from a sibling checkout, which has its own React: make everything use this app's one copy.
    alias: { react: app("react"), "react-dom": app("react-dom") },
    dedupe: ["react", "react-dom"],
  },
  // Do not pre-bundle the linked component: a rebuild of ../../rebarui/packages/core (pnpm --filter rebar-ui build) is picked up live.
  optimizeDeps: { exclude: ["rebar-ui"] },
  server: { port: 5173, fs: { allow: [".."] }, proxy: { "^/hive/(state|stream|buzz|info|join-info)": host, "/join-page": host } },
  build: { outDir: "dist", emptyOutDir: true },
});
