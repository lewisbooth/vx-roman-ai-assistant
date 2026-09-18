import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RouterProvider } from "react-router/dom";
import { createAssistantRouter } from "./app";
import { createStorefrontNavigation } from "./navigation/shared";
import type { AssistantRuntime } from "./runtime";
import { createAssistantTools } from "./tools";
import { createConversationClient } from "./session/client";
import { createStorefrontExecutor } from "./session/storefront-executor";
import { createJourneyObserver } from "./session/journey";
import { createVoiceAutostart } from "./session/voice-autostart";
import { isConversationStorefront } from "../../shared/storefronts";
import { createComposerFocus } from "./chat/composer-focus";
import styles from "./styles.css?inline";

// Reopening or remounting on this document must not restart the loading delay.
let firstLoadingDeadline: number | undefined;

export function mountAssistant(
  host: HTMLElement,
  container: HTMLElement,
  loadingStartedAt: number,
  onSessionChange: (active: boolean) => void = () => {},
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
  let router: ReturnType<typeof createAssistantRouter> | undefined;
  const navigation = createStorefrontNavigation(host);
  const tools = createAssistantTools(
    host,
    navigation,
    (name, input, signal) => session.executeMeasurements(name, input, signal),
    async (view) => {
      if (!router) throw new Error("Roman is still loading. Please try again.");
      await router.navigate(view === "chat" ? "/" : `/${view}`);
    },
  );
  const executor = createStorefrontExecutor(tools);
  const session = createConversationClient(executor);
  const stopJourney = createJourneyObserver(session, navigation);
  const voiceAutostart = isConversationStorefront(window.location.origin)
    ? createVoiceAutostart(session)
    : undefined;
  let root: Root | undefined;
  let disposed = false;
  let readyTimer: number | undefined;
  let sidebarOpen = false;
  const composerFocus = createComposerFocus(container);
  const voiceDock = document.createElement("div");
  voiceDock.hidden = true;
  host.shadowRoot?.append(voiceDock);
  function syncVoiceDock() {
    const state = session.getSnapshot();
    onSessionChange(state.conversation?.status === "active");
    const status = state.voice.status;
    const active =
      status === "starting" || status === "active" || status === "stopping";
    voiceDock.hidden = sidebarOpen || (!active && !state.approval);
    navigation.setSidebarOpen(sidebarOpen || active || !!state.approval);
  }
  const stopVoiceDock = session.subscribe(syncVoiceDock);
  syncVoiceDock();

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
      session,
      voiceDock,
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
    composerFocus.dispose();
    router?.dispose();
    tools.dispose();
    executor.dispose();
    stopJourney();
    voiceAutostart?.dispose();
    session.dispose();
    stopVoiceDock();
    onSessionChange(false);
    voiceDock.remove();
    navigation.dispose();
    throw error;
  }

  return {
    ready,
    focus() {
      if (!disposed && sidebarOpen) composerFocus.focus();
    },
    setOpen(open) {
      if (!disposed) {
        sidebarOpen = open;
        if (!open) composerFocus.cancel();
        syncVoiceDock();
        voiceAutostart?.setOpen(open);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      onError(
        new DOMException("The Roman assistant was removed.", "AbortError"),
      );
      root?.unmount();
      composerFocus.dispose();
      router?.dispose();
      tools.dispose();
      executor.dispose();
      stopJourney();
      voiceAutostart?.dispose();
      session.dispose();
      stopVoiceDock();
      onSessionChange(false);
      voiceDock.remove();
      navigation.dispose();
    },
  };
}
