import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { previewStore } from "./src/navigation/themes";

const { destinations } = previewStore;

export default defineConfig(({ mode }) => ({
  root: fileURLToPath(new URL("./", import.meta.url)),
  publicDir: false,
  plugins: [
    tailwindcss(),
    {
      name: "roman-storefront-preview",
      apply: "serve",
      transformIndexHtml(html, context) {
        const pathname = new URL(
          context.originalUrl ?? context.path,
          "http://localhost",
        ).pathname;
        const page =
          destinations.find((destination) => destination.path === pathname) ??
          destinations[0];
        const template = page.path.startsWith("/products/")
          ? "product"
          : page.path.startsWith("/collections/")
            ? "collection"
            : page.path === "/cart"
              ? "cart"
              : "index";
        const links = destinations
          .map(({ label, path }) => `<li><a href="${path}">${label}</a></li>`)
          .join("");
        return html
          .replace(
            "<!-- roman:page -->",
            `<h1>${page.label}</h1><p>This is a local navigation demo. It does not contain Shopify products, pricing or cart data.</p><ul>${links}</ul>`,
          )
          .replace(
            "<title>Roman storefront preview</title>",
            `<title>${page.label} · Roman preview</title>`,
          )
          .replace('class="template-index"', `class="template-${template}"`);
      },
    },
  ],
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
