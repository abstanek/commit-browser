import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

// The desktop and web variants share the whole frontend but their host: `--mode
// web` swaps the Tauri IPC client for one that talks to the HTTP server, and
// builds into dist-web/ so the two outputs don't clobber each other.
export default defineConfig(({ mode }) => {
  const web = mode === "web";
  return {
    clearScreen: false,
    resolve: {
      alias: {
        "@backend": fileURLToPath(
          new URL(web ? "./src/backend-web.ts" : "./src/backend-tauri.ts", import.meta.url),
        ),
      },
    },
    server: {
      port: web ? 1421 : 1420,
      strictPort: true,
      proxy: web ? { "/api": "http://127.0.0.1:4600" } : undefined,
    },
    build: {
      target: "es2022",
      outDir: web ? "dist-web" : "dist",
    },
  };
});
