import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  clearScreen: false,
  resolve: {
    alias: {
      "@backend": fileURLToPath(new URL("./src/backend-tauri.ts", import.meta.url)),
    },
  },
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    target: "es2022",
  },
});
