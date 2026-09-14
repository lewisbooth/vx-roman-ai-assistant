import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RouterProvider } from "react-router/dom";
import { createAssistantRouter } from "./app";
import { createStorefrontNavigation } from "./navigation/shared";
import type { AssistantRuntime } from "./runtime";
import { createAssistantTools } from "./tools";
import styles from "./styles.css?inline";

// Reopening or remounting on this document must not restart the loading delay.
let firstLoadingDeadline: number | undefined;

export function mountAssistant(
  host: HTMLElement,
  container: HTMLElement,
  loadingStartedAt: number,
): AssistantRuntime {
  const deadline = (firstLoadingDeadline ??= loadingStartedAt + 1000);
  const logoUrl = host.dataset.logoUrl;
  if (!logoUrl) throw new Error("The Roman logo asset is not configured.");

  let resolveReady!: () => void;
  let rejectReady!: (reason: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const navigation = createStorefrontNavigation(host);
  const tools = createAssistantTools(host, navigation);
  let router: ReturnType<typeof createAssistantRouter> | undefined;
  let root: Root | undefined;
  let disposed = false;
  let readyTimer: number | undefined;

  function onReady() {
    if (disposed || readyTimer !== undefined) return;
    const remaining = deadline - window.performance.now();
    if (remaining <= 0) resolveReady();
    else readyTimer = window.setTimeout(resolveReady, remaining);
  }

  function onError(error: unknown) {
    window.clearTimeout(readyTimer);
    rejectReady(error);
  }

  try {
    router = createAssistantRouter({
      logoUrl,
      navigation,
      tools,
      showTools:
        host.dataset.shop === "hd-dev-multi.myshopify.com" ||
        host.dataset.shop === "hd-dev-single.myshopify.com",
      onReady,
      onError,
    });
    root = createRoot(container);
    root.render(
      <StrictMode>
        <style>{styles}</style>
        <RouterProvider router={router} />
      </StrictMode>,
    );
  } catch (error) {
    // No runtime was returned, so the bootstrap cannot dispose these resources.
    disposed = true;
    window.clearTimeout(readyTimer);
    root?.unmount();
    router?.dispose();
    tools.dispose();
    navigation.dispose();
    throw error;
  }

  return {
    ready,
    setOpen(open) {
      if (!disposed) navigation.setSidebarOpen(open);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      onError(
        new DOMException("The Roman assistant was removed.", "AbortError"),
      );
      root?.unmount();
      router?.dispose();
      tools.dispose();
      navigation.dispose();
    },
  };
}
