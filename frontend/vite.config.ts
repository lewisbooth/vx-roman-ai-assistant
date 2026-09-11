import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig(({ mode }) => ({
  root: fileURLToPath(new URL("./", import.meta.url)),
  publicDir: false,
  plugins: [tailwindcss()],
  esbuild: { jsx: "automatic" },
  define: {
    "process.env.NODE_ENV": JSON.stringify(
      mode === "development" ? "development" : "production",
    ),
  },
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
  build: {
    outDir: fileURLToPath(
      new URL("../extensions/vx-roman-ai-assistant/assets", import.meta.url),
    ),
    emptyOutDir: false,
    lib: {
      entry: fileURLToPath(new URL("./src/main.tsx", import.meta.url)),
      name: "RomanAssistant",
      formats: ["iife"],
      fileName: () => "roman-assistant.bundle.js",
    },
  },
}));
