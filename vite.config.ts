/// <reference types="vitest/config" />
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import process from "node:process";

/** Set by `tauri dev` / `tauri build` — keep existing Tauri Vite wiring untouched. */
const tauriHost = process.env.TAURI_DEV_HOST;
const isTauriCli = Boolean(
  process.env.TAURI_ENV_PLATFORM || process.env.TAURI_DEV_HOST,
);

export default defineConfig(() => ({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  server: isTauriCli
    ? {
        port: 1420,
        strictPort: true,
        host: tauriHost || false,
        hmr: tauriHost
          ? {
              protocol: "ws",
              host: tauriHost,
              port: 1421,
            }
          : undefined,
        watch: {
          ignored: ["**/src-tauri/**"],
        },
      }
    : {
        // Plain web / nas compose: Vite behind Caddy at http://hath.dadi (port 80).
        host: "0.0.0.0",
        port: 8080,
        strictPort: true,
        allowedHosts: ["hath.dadi"],
        hmr: {
          clientPort: 80,
        },
        watch: {
          ignored: ["**/src-tauri/**"],
        },
      },
}));
