import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { selectStore } from "./src/navigation/themes";

const previewStore = selectStore("hd-dev-multi.myshopify.com");
if (!previewStore)
  throw new Error("The local preview store is not configured.");
const { destinations } = previewStore;

export default defineConfig(({ mode }) => ({
  root: fileURLToPath(new URL("./", import.meta.url)),
  publicDir: false,
  plugins: [
    tailwindcss(),
    {
      name: "roman-design-assets",
      apply: "build",
      buildStart() {
        if (mode !== "bootstrap") return;
        for (const fileName of [
          "roman-logo.svg",
          "ivory-texture.png",
          "roman-tile-measure-line.png",
          "roman-tile-measure-colour.png",
          "roman-tile-visualize.png",
          "roman-tile-style.png",
          "roman-tile-no-drill.png",
        ]) {
          const path = fileURLToPath(
            new URL(`./src/assets/${fileName}`, import.meta.url),
          );
          this.addWatchFile(path);
          this.emitFile({
            type: "asset",
            fileName,
            source: readFileSync(path),
          });
        }
      },
      generateBundle(_options, bundle) {
        if (mode !== "bootstrap") return;
        const loader = bundle["roman-assistant-loader.bundle.js"];
        if (
          loader?.type === "chunk" &&
          Buffer.byteLength(loader.code) > 10000
        ) {
          this.error(
            `Roman's initial script is ${Buffer.byteLength(loader.code)} bytes; Shopify's app block limit is 10000 bytes.`,
          );
        }
      },
    },
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
      entry: fileURLToPath(
        new URL(
          mode === "bootstrap" ? "./src/bootstrap.ts" : "./src/main.tsx",
          import.meta.url,
        ),
      ),
      name: mode === "bootstrap" ? "RomanBootstrap" : "RomanAssistant",
      formats: ["iife"],
      fileName: () =>
        mode === "bootstrap"
          ? "roman-assistant-loader.bundle.js"
          : "roman-assistant.bundle.js",
    },
  },
}));
