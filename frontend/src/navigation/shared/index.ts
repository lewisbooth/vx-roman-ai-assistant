import {
  commitPage,
  loadPageAssets,
  preparePage,
  resetHeaderAtTop,
  ThemeComponentConflict,
} from "./page";
import { selectStore } from "../themes";

export type NavigationSnapshot = {
  url: string;
  pending: boolean;
  error: string | null;
};

export type StorefrontNavigation = {
  destinations: readonly { label: string; path: string }[];
  getSnapshot: () => NavigationSnapshot;
  subscribe: (listener: () => void) => () => void;
  navigate: (path: string) => Promise<void>;
  setSidebarOpen: (open: boolean) => void;
  dispose: () => void;
};

const historyKey = "__romanNavigation";
type HistoryEntry = {
  segment: string;
  index: number;
  url: string;
  scroll: [number, number];
};

function historyRecord(): Record<string, unknown> {
  const state: unknown = window.history.state;
  return state && typeof state === "object" && !Array.isArray(state)
    ? (state as Record<string, unknown>)
    : {};
}

function savedScroll(): [number, number] | undefined {
  const value = historyRecord()[historyKey] as { scroll?: unknown } | undefined;
  const scroll = value?.scroll;
  return Array.isArray(scroll) &&
    scroll.length === 2 &&
    scroll.every(
      (coordinate) =>
        typeof coordinate === "number" && Number.isFinite(coordinate),
    )
    ? [scroll[0], scroll[1]]
    : undefined;
}

function historyEntry(): HistoryEntry | undefined {
  const value = historyRecord()[historyKey] as
    Partial<HistoryEntry> | undefined;
  const scroll = savedScroll();
  return value &&
    typeof value.segment === "string" &&
    Number.isInteger(value.index) &&
    typeof value.url === "string" &&
    scroll
    ? ({ ...value, scroll } as HistoryEntry)
    : undefined;
}

export function createStorefrontNavigation(
  host: HTMLElement,
): StorefrontNavigation {
  const store = selectStore(host.dataset.shop);
  const destinations = store?.destinations ?? [];
  // Back may return to the page on which the assistant was first opened, even
  // when that page is not one of the configured sidebar shortcuts.
  const supportedPaths = new Set([
    ...destinations.map(({ path }) => path),
    window.location.pathname,
  ]);
  const listeners = new Set<() => void>();
  let currentUrl = window.location.href;
  let snapshot: NavigationSnapshot = {
    url: currentUrl,
    pending: false,
    error: store
      ? null
      : "Roman navigation is not configured for this storefront.",
  };
  let controller: AbortController | undefined;
  let open = false;
  let started = false;
  let disposed = false;
  let scrollTimer: number | undefined;
  let previousScrollRestoration: ScrollRestoration;
  let displayedEntry: HistoryEntry | undefined;
  let restoringEntry: HistoryEntry | undefined;
  let handingOff = false;

  function publish(update: Partial<NavigationSnapshot>) {
    snapshot = { ...snapshot, ...update };
    listeners.forEach((listener) => listener());
  }

  function supportsPath(path: string): boolean {
    if (supportedPaths.has(path)) return true;
    const product = /^\/collections\/[^/]+\/products\/([^/]+)$/.exec(path);
    return !!product && supportedPaths.has(`/products/${product[1]}`);
  }

  function supportedUrl(path: string): URL {
    const url = new URL(path, window.location.href);
    if (
      url.origin !== window.location.origin ||
      url.username ||
      url.password ||
      !supportsPath(url.pathname)
    ) {
      throw new Error(
        "This destination is outside Roman's configured storefront routes.",
      );
    }
    if (
      url.searchParams.has("sections") ||
      url.searchParams.has("section_id")
    ) {
      throw new Error("Navigation requires a complete storefront page.");
    }
    return url;
  }

  function saveScroll() {
    if (!started || window.location.href !== currentUrl) return;
    const previous = historyEntry();
    const owned =
      previous?.segment === displayedEntry?.segment &&
      previous?.index === displayedEntry?.index &&
      previous?.url === currentUrl;
    displayedEntry = {
      segment: owned && previous ? previous.segment : crypto.randomUUID(),
      index: owned && previous ? previous.index : 0,
      url: currentUrl,
      scroll: [window.scrollX, window.scrollY],
    };
    window.history.replaceState(
      {
        ...historyRecord(),
        [historyKey]: displayedEntry,
      },
      "",
      currentUrl,
    );
  }

  function onScroll() {
    if (scrollTimer !== undefined) return;
    scrollTimer = window.setTimeout(() => {
      scrollTimer = undefined;
      saveScroll();
    }, 100);
  }

  function start() {
    if (started) return;
    started = true;
    previousScrollRestoration = window.history.scrollRestoration;
    window.history.scrollRestoration = "manual";
    saveScroll();
    window.addEventListener("popstate", onPopState);
    window.addEventListener("scroll", onScroll, { passive: true });
  }

  async function visit(path: string, fromHistory = false) {
    if (disposed || restoringEntry || handingOff) return;
    controller?.abort();
    const request = new AbortController();
    controller = request;
    const timeout = window.setTimeout(
      () =>
        request.abort(new Error("The page request timed out. Please retry.")),
      15000,
    );
    // The theme also updates query parameters for filters, variants and sizes.
    // Preserve its latest URL when creating an outgoing history entry.
    if (!fromHistory) currentUrl = window.location.href;
    const oldUrl = currentUrl;
    const oldMain = document.querySelector("app-provider > main#main");
    let oldState = window.history.state;
    const scroll = fromHistory ? savedScroll() : undefined;
    const targetEntry = fromHistory ? historyEntry() : undefined;
    let replacedUrl = false;
    let pushedEntry = false;
    let outgoingEntry: HistoryEntry | undefined;
    let destination: URL | undefined;

    try {
      if (!store) {
        throw new Error(
          "Roman navigation is not configured for this storefront.",
        );
      }
      if (!oldMain || oldMain.contains(host)) {
        throw new Error(
          "The theme must have app-provider > main#main outside Roman.",
        );
      }
      const url = supportedUrl(path);
      const previewTheme = new URL(currentUrl).searchParams.get(
        "preview_theme_id",
      );
      if (previewTheme && !url.searchParams.has("preview_theme_id")) {
        url.searchParams.set("preview_theme_id", previewTheme);
      }
      start();
      if (!fromHistory) {
        saveScroll();
        oldState = window.history.state;
      }
      publish({ pending: true, error: null });
      const response = await window.fetch(url.href, {
        credentials: "same-origin",
        headers: { Accept: "text/html" },
        signal: request.signal,
      });
      if (!response.ok)
        throw new Error(
          `The store returned HTTP ${response.status}. The current page has been kept.`,
        );
      const finalUrl = supportedUrl(response.url || url.href);
      // Fetch strips the requested fragment; native navigation must retain it.
      if (!finalUrl.hash) finalUrl.hash = url.hash;
      if (!response.headers.get("content-type")?.includes("text/html")) {
        throw new Error("The store did not return an HTML page.");
      }
      const html = await response.text();
      // Resource loaders have their own deadlines. A page-fetch timeout must not
      // turn a nonfatal asset timeout into a cancelled navigation.
      window.clearTimeout(timeout);
      request.signal.throwIfAborted();
      destination = finalUrl;
      const page = preparePage(html, finalUrl, store.theme);
      await loadPageAssets(page, request.signal);
      request.signal.throwIfAborted();
      if (controller !== request || disposed) return;

      // Set the destination once, just before components connect. Temporary URL
      // changes also reach theme analytics and can produce duplicate pageviews.
      const { main, error: initializationError } = commitPage(page, () => {
        if (!fromHistory) {
          outgoingEntry = displayedEntry;
          displayedEntry = {
            segment: displayedEntry!.segment,
            index: displayedEntry!.index + 1,
            url: finalUrl.href,
            scroll: [0, 0],
          };
          window.history.pushState(
            { [historyKey]: displayedEntry },
            "",
            finalUrl.href,
          );
          pushedEntry = true;
        } else {
          if (window.location.href !== finalUrl.href) {
            window.history.replaceState(historyRecord(), "", finalUrl.href);
          }
          displayedEntry = targetEntry;
        }
        replacedUrl = true;
      });
      currentUrl = finalUrl.href;
      publish({
        url: currentUrl,
        pending: false,
        error: initializationError ?? null,
      });
      if (!host.shadowRoot?.activeElement) {
        main.setAttribute("tabindex", "-1");
        main.focus({ preventScroll: true });
      }
      if (scroll)
        window.scrollTo({
          left: scroll[0],
          top: scroll[1],
          behavior: "instant",
        });
      else if (finalUrl.hash) {
        document
          .getElementById(decodeURIComponent(finalUrl.hash.slice(1)))
          ?.scrollIntoView();
      } else window.scrollTo({ left: 0, top: 0, behavior: "instant" });
      resetHeaderAtTop();
      document.dispatchEvent(
        new CustomEvent("roman:navigation", { detail: { url: currentUrl } }),
      );
    } catch (error) {
      if (controller !== request || disposed) return;
      if (
        request.signal.aborted &&
        !request.signal.reason?.message?.includes("timed out")
      )
        return;
      if (error instanceof ThemeComponentConflict && destination) {
        console.error(
          "[Roman] Theme component conflict; loading the full page.",
          {
            destination: `${destination.origin}${destination.pathname}`,
            reason: error.message,
          },
        );
        handingOff = true;
        request.abort();
        window.clearTimeout(scrollTimer);
        scrollTimer = undefined;
        window.history.scrollRestoration = previousScrollRestoration;
        // Avoid treating this intentional handoff as a failed history visit on
        // disposal. The old content remains untouched until the browser leaves.
        publish({ pending: false, error: null });
        if (!fromHistory) window.location.assign(destination.href);
        else if (window.location.href === destination.href)
          window.location.reload();
        else window.location.replace(destination.href);
        return;
      }
      // A theme initialization error after insertion is different from a failed
      // fetch: keep the displayed destination and its URL consistent.
      if (replacedUrl && oldMain && !oldMain.isConnected)
        currentUrl = window.location.href;
      else if (fromHistory) {
        // Restore the previous history position, never overwrite the destination
        // of a failed Back/Forward request. Native theme entries have no reliable
        // relative index, so fall back to loading their actual destination.
        if (
          targetEntry &&
          displayedEntry &&
          targetEntry.segment === displayedEntry.segment &&
          targetEntry.index !== displayedEntry.index
        ) {
          restoringEntry = displayedEntry;
          window.history.go(displayedEntry.index - targetEntry.index);
        } else window.location.reload();
      } else if (pushedEntry && outgoingEntry) {
        displayedEntry = outgoingEntry;
        restoringEntry = outgoingEntry;
        window.history.back();
      } else if (replacedUrl) window.history.replaceState(oldState, "", oldUrl);
      const cause = request.signal.aborted ? request.signal.reason : error;
      publish({
        url: currentUrl,
        pending: !!restoringEntry,
        error:
          cause instanceof Error
            ? cause.message
            : "The page could not be loaded. Please retry.",
      });
    } finally {
      window.clearTimeout(timeout);
      if (controller === request) controller = undefined;
    }
  }

  function onClick(event: MouseEvent) {
    if (
      !store ||
      handingOff ||
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    const anchor = event
      .composedPath()
      .find(
        (node): node is HTMLAnchorElement => node instanceof HTMLAnchorElement,
      );
    if (
      !anchor ||
      host.contains(anchor) ||
      anchor.hasAttribute("download") ||
      (anchor.target && anchor.target !== "_self") ||
      anchor.closest("[data-roman-native-navigation]")
    )
      return;
    if (anchor.hasAttribute("data-roman-back")) {
      event.preventDefault();
      const entry = historyEntry();
      if (
        entry &&
        entry.segment === displayedEntry?.segment &&
        entry.index > 0 &&
        entry.url === window.location.href
      ) {
        window.history.back();
      } else void visit("/");
      return;
    }
    if (!open) return;
    const url = new URL(anchor.href, window.location.href);
    if (url.origin !== window.location.origin || !supportsPath(url.pathname))
      return;
    if (
      url.pathname === window.location.pathname &&
      url.search === window.location.search
    )
      return;
    event.preventDefault();
    void visit(url.href);
  }

  function onPopState() {
    if (handingOff) {
      handingOff = false;
      window.history.scrollRestoration = "manual";
    }
    if (restoringEntry) {
      const entry = historyEntry();
      const restored =
        entry?.segment === restoringEntry.segment &&
        entry?.index === restoringEntry.index &&
        window.location.href === currentUrl;
      restoringEntry = undefined;
      if (restored) {
        publish({ pending: false });
        return;
      }
    }
    const url = new URL(window.location.href);
    if (supportsPath(url.pathname)) void visit(url.href, true);
    else {
      controller?.abort();
      window.location.reload();
    }
  }

  function onPageShow(event: PageTransitionEvent) {
    if (!event.persisted || !handingOff || disposed) return;
    handingOff = false;
    if (started) window.history.scrollRestoration = "manual";
    currentUrl = window.location.href;
    displayedEntry = historyEntry();
    publish({ url: currentUrl, pending: false, error: null });
  }

  if (store) {
    document.addEventListener("click", onClick);
    window.addEventListener("pageshow", onPageShow);
  }

  return {
    destinations,
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    navigate: (path) => visit(path),
    setSidebarOpen(isOpen) {
      if (disposed || !store || open === isOpen) return;
      open = isOpen;
    },
    dispose() {
      if (
        started &&
        snapshot.pending &&
        window.location.href !== currentUrl &&
        !restoringEntry
      ) {
        const target = historyEntry();
        if (
          target &&
          displayedEntry &&
          target.segment === displayedEntry.segment &&
          target.index !== displayedEntry.index
        ) {
          window.history.go(displayedEntry.index - target.index);
        } else window.location.reload();
      }
      disposed = true;
      controller?.abort();
      window.clearTimeout(scrollTimer);
      document.removeEventListener("click", onClick);
      window.removeEventListener("popstate", onPopState);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("pageshow", onPageShow);
      if (started) window.history.scrollRestoration = previousScrollRestoration;
      listeners.clear();
    },
  };
}
