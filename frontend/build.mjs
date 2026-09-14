import { fileURLToPath } from "node:url";
import { build } from "vite";

// Both entry points must be rebuilt together before Shopify publishes assets.
for (const mode of ["bootstrap", "sidebar"]) {
  await build({
    configFile: fileURLToPath(new URL("./vite.config.ts", import.meta.url)),
    mode,
    build: { watch: process.argv.includes("--watch") ? {} : null },
  });
}
