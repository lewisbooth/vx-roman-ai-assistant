import {
  commitPage,
  loadPageAssets,
  preparePage,
  resetHeaderAtTop,
} from "./page";
import { selectStore } from "../themes";

export type NavigationSnapshot = {
  url: string;
  pending: boolean;
  error: string | null;
};

export type NavigationOutcome =
  "navigated" | "handed_off" | "cancelled" | "failed";

export type StorefrontNavigation = {
  destinations: readonly { label: string; path: string }[];
  getSnapshot: () => NavigationSnapshot;
  subscribe: (listener: () => void) => () => void;
  navigate: (path: string, signal?: AbortSignal) => Promise<NavigationOutcome>;
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
  let handingOff = false;

  function publish(update: Partial<NavigationSnapshot>) {
    snapshot = { ...snapshot, ...update };
    listeners.forEach((listener) => listener());
  }

  function storefrontUrl(path: string): URL {
    const url = new URL(path, window.location.href);
    if (
      url.origin !== window.location.origin ||
      url.username ||
      url.password ||
      !/^https?:$/.test(url.protocol)
    ) {
      throw new Error(
        "Navigation requires a same-origin storefront URL without credentials.",
      );
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

  async function visit(
    path: string,
    fromHistory = false,
    signal?: AbortSignal,
  ): Promise<NavigationOutcome> {
    if (disposed || signal?.aborted) return "cancelled";
    if (handingOff) return "handed_off";
    controller?.abort();
    const request = new AbortController();
    controller = request;
    const abort = () => request.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      request.abort(new Error("The page request timed out."));
    }, 15000);
    // The theme also updates query parameters for filters, variants and sizes.
    // Preserve its latest URL when creating an outgoing history entry.
    if (!fromHistory) currentUrl = window.location.href;
    const oldMain = document.querySelector("app-provider > main#main");
    const scroll = fromHistory ? savedScroll() : undefined;
    const targetEntry = fromHistory ? historyEntry() : undefined;
    let replacedUrl = false;
    let destination: URL | undefined;

    try {
      if (!store) {
        throw new Error(
          "Roman navigation is not configured for this storefront.",
        );
      }
      const url = storefrontUrl(path);
      const previewTheme = new URL(currentUrl).searchParams.get(
        "preview_theme_id",
      );
      if (previewTheme && !url.searchParams.has("preview_theme_id")) {
        url.searchParams.set("preview_theme_id", previewTheme);
      }
      destination = url;
      if (
        url.searchParams.has("sections") ||
        url.searchParams.has("section_id")
      )
        throw new Error(
          "Partial storefront responses require normal navigation.",
        );
      if (!oldMain || oldMain.contains(host)) {
        throw new Error(
          "The theme must have app-provider > main#main outside Roman.",
        );
      }
      start();
      if (!fromHistory) saveScroll();
      publish({ pending: true, error: null });
      const response = await window.fetch(url.href, {
        credentials: "same-origin",
        headers: { Accept: "text/html" },
        signal: request.signal,
      });
      const finalUrl = storefrontUrl(response.url || url.href);
      // Fetch strips the requested fragment; native navigation must retain it.
      if (!finalUrl.hash) finalUrl.hash = url.hash;
      destination = finalUrl;
      if (!response.ok)
        throw new Error(`The store returned HTTP ${response.status}.`);
      if (!response.headers.get("content-type")?.includes("text/html")) {
        throw new Error("The store did not return an HTML page.");
      }
      const html = await response.text();
      // Resource loaders have their own deadlines. A page-fetch timeout must not
      // turn a nonfatal asset timeout into a cancelled navigation.
      window.clearTimeout(timeout);
      request.signal.throwIfAborted();
      const page = preparePage(html, finalUrl, store.theme);
      await loadPageAssets(page, request.signal);
      request.signal.throwIfAborted();
      if (controller !== request || disposed) return "cancelled";

      // Set the destination once, just before components connect. Temporary URL
      // changes also reach theme analytics and can produce duplicate pageviews.
      const { main, error: initializationError } = commitPage(page, () => {
        if (!fromHistory) {
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
        } else {
          if (window.location.href !== finalUrl.href) {
            window.history.replaceState(historyRecord(), "", finalUrl.href);
          }
          displayedEntry = targetEntry;
        }
        replacedUrl = true;
      });
      currentUrl = finalUrl.href;
      if (initializationError) throw new Error(initializationError);
      publish({
        url: currentUrl,
        pending: false,
        error: null,
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
      return "navigated";
    } catch (error) {
      if (controller !== request || disposed) return "cancelled";
      if (request.signal.aborted && !timedOut) {
        publish({ pending: false, error: null });
        return "cancelled";
      }
      const cause = request.signal.aborted ? request.signal.reason : error;
      if (destination) {
        // Error messages can contain asset/request URLs. Keep useful context
        // without copying their credentials, query parameters or fragments.
        const reason = (
          cause instanceof Error
            ? cause.message
            : "Storefront navigation failed."
        )
          .replace(/https?:\/\/[^\s"'<>]+/g, (value) => {
            try {
              const url = new URL(value);
              return `${url.origin}${url.pathname}`;
            } catch {
              return "[URL]";
            }
          })
          .replace(/[?#][^\s"'<>)]*/g, "[redacted]")
          .slice(0, 500);
        console.error(
          "[Roman] Storefront navigation failed; loading the full page.",
          {
            destination: `${destination.origin}${destination.pathname}`,
            reason,
          },
        );
        handingOff = true;
        request.abort();
        window.clearTimeout(scrollTimer);
        scrollTimer = undefined;
        if (started)
          window.history.scrollRestoration = previousScrollRestoration;
        // Avoid treating this intentional handoff as a failed history visit on
        // disposal, including failures after the destination was inserted.
        if (replacedUrl) currentUrl = window.location.href;
        publish({ pending: false, error: null });
        if (!fromHistory && !replacedUrl)
          window.location.assign(destination.href);
        else if (window.location.href === destination.href)
          window.location.reload();
        else window.location.replace(destination.href);
        return "handed_off";
      }
      publish({
        url: currentUrl,
        pending: false,
        error:
          cause instanceof Error
            ? cause.message
            : "The page could not be loaded. Please retry.",
      });
      return "failed";
    } finally {
      signal?.removeEventListener("abort", abort);
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
    let url: URL;
    try {
      url = storefrontUrl(anchor.href);
    } catch {
      return;
    }
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
    void visit(window.location.href, true);
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
    navigate: (path, signal) => visit(path, false, signal),
    setSidebarOpen(isOpen) {
      if (disposed || !store || open === isOpen) return;
      open = isOpen;
    },
    dispose() {
      if (started && snapshot.pending && window.location.href !== currentUrl) {
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
