import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { NavigateFunction } from "react-router";
import { AssistantApp } from "./app";
import { createStorefrontNavigation } from "./navigation/shared";
import type { AssistantRuntime } from "./runtime";
import { createAssistantTools } from "./tools";
import { createConversationClient } from "./session/client";
import { createStorefrontExecutor } from "./session/storefront-executor";
import { createJourneyObserver } from "./session/journey";
import { createComposerFocus } from "./chat/composer-focus";
import { createAssistantViewport } from "./assistant-viewport";
import { createStorefrontScroll } from "./storefront-scroll";
import { createStorefrontCartNotification } from "./storefront-cart-notification";
import { currentVisualizationProduct } from "./visualizations/entry";
import stylesheetUrl from "./assistant-viewport.css?url";

// Reopening or remounting on this document must not restart the loading delay.
let firstLoadingDeadline: number | undefined;

export function mountAssistant(
  host: HTMLElement,
  container: HTMLElement,
  loadingStartedAt: number,
  onThemeChange: (welcome: boolean) => void,
): AssistantRuntime {
  const deadline = (firstLoadingDeadline ??= loadingStartedAt + 1000);
  const logoUrl = host.dataset.logoUrl;
  if (!logoUrl) throw new Error("The Roman logo asset is not configured.");
  const shadow = host.shadowRoot;
  if (!shadow) throw new Error("The Roman assistant host is not ready.");

  let resolveReady!: () => void;
  let rejectReady!: (reason: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  let navigateView: NavigateFunction | undefined;
  const storefrontScroll = createStorefrontScroll();
  storefrontScroll.setTheme(
    container.closest("[data-roman-panel]")?.hasAttribute("data-welcome-theme") ?? false,
  );
  const cartNotification = createStorefrontCartNotification();
  const navigation = createStorefrontNavigation(host, storefrontScroll);
  const tools = createAssistantTools(
    host,
    navigation,
    (name, input, signal) => session.executeMeasurements(name, input, signal),
    async (view) => {
      if (!navigateView) throw new Error("Roman is still loading. Please try again.");
      await navigateView(view === "chat" ? "/" : `/${view}`);
    },
  );
  const executor = createStorefrontExecutor(tools);
  const session = createConversationClient(executor);
  const stopJourney = createJourneyObserver(session, navigation);
  let root: Root | undefined;
  let disposed = false;
  let failed = false;
  let appReady = false;
  let stylesReady = false;
  let readyTimer: number | undefined;
  let stylesheetTimer: number | undefined;
  let sidebarOpen = false;
  const composerFocus = createComposerFocus(container);
  const viewport = createAssistantViewport(host);
  const stylesheet = document.createElement("link");
  stylesheet.rel = "stylesheet";
  stylesheet.href = stylesheetUrl;

  function finishReady() {
    if (disposed || failed || !appReady || !stylesReady || readyTimer !== undefined) return;
    const remaining = deadline - window.performance.now();
    if (remaining <= 0) resolveReady();
    else readyTimer = window.setTimeout(resolveReady, remaining);
  }

  function onReady(welcome: boolean) {
    if (disposed || failed) return;
    storefrontScroll.setTheme(welcome);
    onThemeChange(welcome);
    appReady = true;
    finishReady();
  }

  function stopStylesheetLoading() {
    window.clearTimeout(stylesheetTimer);
    stylesheet.onload = stylesheet.onerror = null;
  }

  function onError(error: unknown) {
    failed = true;
    window.clearTimeout(readyTimer);
    stopStylesheetLoading();
    rejectReady(error);
  }

  try {
    stylesheet.onload = () => {
      stopStylesheetLoading();
      stylesReady = true;
      finishReady();
    };
    stylesheet.onerror = () => onError(new Error("Roman could not load its styles. Retry."));
    stylesheetTimer = window.setTimeout(
      () => onError(new Error("Roman's styles timed out. Retry.")),
      15000,
    );
    // Keep the link outside React's container and the shell hidden until it loads.
    shadow.append(stylesheet);
    root = createRoot(container);
    root.render(
      <StrictMode>
        <AssistantApp
          logoUrl={logoUrl}
          navigation={navigation}
          session={session}
          onReady={onReady}
          onError={onError}
          onNavigate={(navigate) => { navigateView = navigate; }}
        />
      </StrictMode>,
    );
  } catch (error) {
    // No runtime was returned, so the bootstrap cannot dispose these resources.
    disposed = true;
    window.clearTimeout(readyTimer);
    stopStylesheetLoading();
    stylesheet.remove();
    root?.unmount();
    composerFocus.dispose();
    viewport.dispose();
    storefrontScroll.dispose();
    cartNotification.dispose();
    navigateView = undefined;
    tools.dispose();
    executor.dispose();
    stopJourney();
    session.dispose();
    navigation.dispose();
    throw error;
  }

  return {
    ready,
    focus() {
      if (!disposed && sidebarOpen) composerFocus.focus();
    },
    visualizeProduct(productPath) {
      if (disposed || !sidebarOpen || !currentVisualizationProduct(productPath)) return;
      void navigateView?.("/", { state: { visualizeProduct: productPath, requestId: window.crypto.randomUUID() } });
    },
    setOpen(open) {
      if (!disposed) {
        const closing = sidebarOpen && !open;
        sidebarOpen = open;
        storefrontScroll.setLocked(open);
        cartNotification.setOpen(open);
        viewport.setOpen(open);
        if (!open) composerFocus.cancel();
        navigation.setSidebarOpen(open);
        session.setOpen(open);
        const { voice, conversation } = session.getSnapshot();
        if (
          closing &&
          (voice.status === "starting" ||
            voice.status === "active" ||
            voice.status === "stopping" ||
            (voice.status === "error" && voice.muted) ||
            conversation?.voice?.status === "starting" ||
            conversation?.voice?.status === "active")
        ) {
          // stopVoice closes local media synchronously and retains any server
          // finalization error for the next open. Idle text tools keep running.
          void session.stopVoice().catch(() => undefined);
        }
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      onError(
        new DOMException("The Roman assistant was removed.", "AbortError"),
      );
      stylesheet.remove();
      root?.unmount();
      composerFocus.dispose();
      viewport.dispose();
      storefrontScroll.dispose();
      cartNotification.dispose();
      navigateView = undefined;
      tools.dispose();
      executor.dispose();
      stopJourney();
      session.dispose();
      navigation.dispose();
    },
  };
}
