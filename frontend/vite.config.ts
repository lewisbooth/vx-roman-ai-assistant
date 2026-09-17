import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const previewPages = [
  { label: "Home", path: "/" },
  { label: "All blinds", path: "/collections/all" },
  {
    label: "Traditional zebra shades",
    path: "/products/traditional-room-darkening-zebra-shades",
  },
  {
    label: "LEVOLOR faux wood blinds",
    path: "/products/2-inch-levolor-classic-neutral-faux-wood-blinds",
  },
  { label: "Cart", path: "/cart" },
];

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
          "roman-wordmark.svg",
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
          previewPages.find((destination) => destination.path === pathname) ??
          previewPages[0];
        const template = page.path.startsWith("/products/")
          ? "product"
          : page.path.startsWith("/collections/")
            ? "collection"
            : page.path === "/cart"
              ? "cart"
              : "index";
        const links = previewPages
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
    // Native private fields keep the initial script below Shopify's 10 KB cap.
    // Tailwind 4 already requires browsers newer than ES2022 support.
    target: mode === "bootstrap" ? "es2022" : undefined,
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
