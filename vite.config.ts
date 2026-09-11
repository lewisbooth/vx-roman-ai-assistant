import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, loadEnv, type UserConfig } from "vite";

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ""), ...process.env };

  // Preserve compatibility with Shopify CLI versions that supply HOST.
  if (env.HOST && (!env.SHOPIFY_APP_URL || env.SHOPIFY_APP_URL === env.HOST)) {
    env.SHOPIFY_APP_URL = env.HOST;
    process.env.SHOPIFY_APP_URL = env.HOST;
    delete process.env.HOST;
  }

  const host = new URL(env.SHOPIFY_APP_URL || "http://localhost").hostname;
  const isLocal = ["localhost", "127.0.0.1", "[::1]"].includes(host);

  return {
    server: {
      allowedHosts: [host],
      cors: {
        preflightContinue: true,
      },
      port: Number(env.PORT || 3000),
      hmr: isLocal
        ? {
            protocol: "ws",
            host,
            port: 64999,
            clientPort: 64999,
          }
        : {
            protocol: "wss",
            host,
            port: parseInt(env.FRONTEND_PORT || "", 10) || 8002,
            clientPort: 443,
          },
      fs: {
        allow: ["admin", "shared", "node_modules"],
      },
    },
    plugins: [tailwindcss(), reactRouter()],
    build: {
      assetsInlineLimit: 0,
    },
  } satisfies UserConfig;
});
