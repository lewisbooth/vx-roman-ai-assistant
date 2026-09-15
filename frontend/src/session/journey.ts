import type { StorefrontNavigation } from "../navigation/shared";
import type { ConversationClient } from "./types";
import { isStorefrontPagePath } from "../../../shared/journey";

/** Observe completed pages, independently of whether the sidebar is visible. */
export function createJourneyObserver(
  session: ConversationClient,
  navigation: StorefrontNavigation,
): () => void {
  let conversationId: string | undefined;
  let previousPath: string | undefined;
  let disposed = false;

  function recordPage() {
    const { conversation, restoring } = session.getSnapshot();
    if (disposed || restoring) return;
    if (!conversation || conversation.status !== "active") {
      conversationId = undefined;
      previousPath = undefined;
      return;
    }
    if (conversation.id !== conversationId) {
      conversationId = conversation.id;
      previousPath = undefined;
    }
    if (navigation.getSnapshot().pending) return;
    // Query strings/fragments can hold personal data and are not journey input.
    const path = window.location.pathname;
    if (!isStorefrontPagePath(path, window.location.origin)) {
      previousPath = undefined;
      return;
    }
    if (path === previousPath) return;
    previousPath = path;
    const title = (
      document
        .querySelector("app-provider > main#main h1")
        ?.textContent?.trim() ||
      document.title.trim() ||
      path
    )
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200);
    // The client owns retry identity and reports failures in its normal state.
    void session
      .recordPage({
        title,
        path,
        occurredAt: new Date().toISOString(),
      })
      .catch(() => {});
  }

  function onPageShow(event: PageTransitionEvent) {
    if (!event.persisted) return;
    previousPath = undefined;
    recordPage();
  }

  const unsubscribe = session.subscribe(recordPage);
  document.addEventListener("roman:navigation", recordPage);
  window.addEventListener("pageshow", onPageShow);
  recordPage();
  return () => {
    disposed = true;
    unsubscribe();
    document.removeEventListener("roman:navigation", recordPage);
    window.removeEventListener("pageshow", onPageShow);
  };
}
