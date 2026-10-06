import { APP_NAME } from "../../shared/brand";
import { CONVERSATION_STORAGE_KEY } from "../../shared/conversation";
import styles from "./bootstrap.css?inline";
import layoutCss from "./storefront.css?inline";
import { attachHeaderLauncher } from "./header-launcher";
import type { AssistantRuntime } from "./runtime";
import { readWelcomeState } from "./welcome-state";
import { brandLogoUrl } from "./brand-logo";

type RuntimeModule = {
  mountAssistant: (
    host: HTMLElement,
    container: HTMLElement,
    loadingStartedAt: number,
    onThemeChange: (welcome: boolean) => void,
  ) => AssistantRuntime;
};
declare global {
  interface Window {
    RomanAssistant?: RuntimeModule;
  }
}

let download:
  { url: string; promise: Promise<RuntimeModule>; failed: boolean } | undefined;
let loadingStartedAt: number | undefined;

const visibilityKey = "roman:sidebar-open";
const startError = "Roman could not start.";
const focusOptions = { preventScroll: true };
let storageUnavailable = false;

function savedState(value?: string, key = visibilityKey): string | null {
  if (storageUnavailable) return null;
  try {
    if (value === undefined) return window.sessionStorage.getItem(key);
    window.sessionStorage.setItem(key, value);
    return value;
  } catch {
    storageUnavailable = true;
    console.warn(
      "[Roman] Storage failed.",
    );
    return null;
  }
}

function loadRuntime(url: string, retry: boolean): Promise<RuntimeModule> {
  if (import.meta.env.DEV) return import("./main");
  if (retry && download?.failed) download = undefined;
  if (download) {
    if (download.url !== url)
      return Promise.reject(
        new Error("Roman changed. Refresh."),
      );
    return download.promise;
  }
  let failed = false;
  const promise = new Promise<RuntimeModule>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = url;
    script.dataset.romanRuntime = "";
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      script.onload = script.onerror = null;
      if (error) {
        failed = true;
        script.remove();
        reject(error);
      } else resolve(window.RomanAssistant!);
    };
    const timeout = setTimeout(
      () => finish(new Error("Roman timed out.")),
      15000,
    );
    script.onload = () =>
      finish(
        typeof window.RomanAssistant?.mountAssistant === "function"
          ? undefined
          : new Error(startError),
      );
    script.onerror = () =>
      finish(
        new Error("Connection failed."),
      );
    try {
      document.head.append(script);
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
  download = {
    url,
    promise,
    get failed() {
      return failed;
    },
  };
  return promise;
}

class RomanAssistant extends HTMLElement {
  // Native private names minify without exposing lifecycle state on the host.
  #headerLauncher?: ReturnType<typeof attachHeaderLauncher>;
  #panel?: HTMLElement;
  #closeButton?: HTMLButtonElement;
  #content?: HTMLDivElement;
  #loading?: HTMLDivElement;
  #logo?: HTMLImageElement;
  #progress?: HTMLDivElement;
  #error?: HTMLParagraphElement;
  #retryButton?: HTMLButtonElement;
  #layout?: HTMLStyleElement;
  #runtime?: AssistantRuntime;
  #open = false;
  #themeKnown = false;
  #state: "idle" | "loading" | "ready" | "error" = "idle";
  #generation = 0;
  #visualizationPath?: string;
  #onVisualizationClick = (event: MouseEvent) => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest<HTMLButtonElement>("button[data-roman-visualize-product]");
    const path = button?.dataset.romanVisualizeProduct;
    if (!path || button!.disabled) return;
    event.preventDefault();
    this.#visualizationPath = path;
    this.#setOpen(true);
    this.#launchVisualization();
  };

  #launchVisualization() {
    if (this.#state !== "ready" || !this.#visualizationPath) return;
    const path = this.#visualizationPath;
    this.#visualizationPath = undefined;
    // Native PDP identity and canonical paths are validated by the lazy runtime.
    this.#runtime!.visualizeProduct(path);
  }
  #onPageShow = (event: PageTransitionEvent) => {
    if (event.persisted) this.#restore();
  };
  #onFocus = (event: Event) => {
    if (this.#open && !event.composedPath().includes(this.#panel!))
      this.#closeButton?.focus(focusOptions);
  };

  #restore() {
    const open =
      /(?:^\?|&)roman=true(?:&|$)/.test(location.search) ||
      savedState() === "1";
    if (open || !storageUnavailable) this.#setOpen(open, false);
    if (
      this.#state === "idle" &&
      savedState(undefined, CONVERSATION_STORAGE_KEY)
    )
      void this.#start();
  }

  connectedCallback() {
    if (this.#headerLauncher) return;
    const shadow = this.shadowRoot ?? this.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = styles;
    shadow.replaceChildren(style);
    this.#headerLauncher = attachHeaderLauncher(
      style,
      () => this.#setOpen(!this.#open),
      this.dataset.wordmarkUrl || "",
      this.dataset.label || APP_NAME,
    );
    window.addEventListener("pageshow", this.#onPageShow);
    document.addEventListener("click", this.#onVisualizationClick);
    this.#restore();
  }

  #createPanel() {
    const panel = document.createElement("section");
    panel.hidden = !this.#open;
    panel.dataset.romanPanel = "";
    panel.ariaLabel = this.dataset.label || APP_NAME;
    panel.role = "dialog";
    panel.ariaModal = "true";
    panel.className = "roman-panel";
    // Static markup only. Theme-provided URLs are assigned as DOM properties.
    panel.innerHTML = `
<div class=roman-frame hidden></div>
<div class=r-loading>
<img class=r-brand alt="Roman by SelectBlinds">
<div class=r-track role=progressbar aria-label="Loading Roman"><div class=r-progress></div></div>
<p class=r-error role=alert hidden></p>
<button class=r-retry hidden>Retry</button>
</div>
<button class=roman-close aria-label="Close assistant">×</button>`;
    const query = panel.querySelector.bind(panel);
    this.#logo = query<HTMLImageElement>(".r-brand")!;
    this.#panel = panel;
    this.#closeButton = query<HTMLButtonElement>(".roman-close")!;
    this.#content = query<HTMLDivElement>(".roman-frame")!;
    this.#loading = query<HTMLDivElement>(".r-loading")!;
    this.#progress = query<HTMLDivElement>(".r-track")!;
    this.#error = query<HTMLParagraphElement>(".r-error")!;
    this.#retryButton = query<HTMLButtonElement>(".r-retry")!;
    this.#closeButton.addEventListener("click", () => this.#setOpen(false));
    this.#retryButton.addEventListener("click", () => void this.#start(true));
    panel.addEventListener("keydown", (event) => {
      if (event.key === "Tab" && !event.defaultPrevented) {
        const controls = [...panel.querySelectorAll<HTMLElement>(
          "a[href],button,input,textarea,select,[tabindex]",
        )].filter((element) => element.tabIndex >= 0 &&
          !element.matches(":disabled") && element.getClientRects().length &&
          getComputedStyle(element).visibility !== "hidden");
        const edge = event.shiftKey ? controls[0] : controls.at(-1);
        if (!edge || this.shadowRoot!.activeElement === edge) {
          event.preventDefault();
          (event.shiftKey ? controls.at(-1) : controls[0])?.focus();
        }
      }
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      this.#setOpen(false);
    });
    this.shadowRoot!.append(panel);
    const layout = document.createElement("style");
    layout.dataset.romanLayout = "";
    layout.textContent = layoutCss;
    this.#layout = layout;
    const welcome = readWelcomeState();
    if (welcome !== undefined) this.#setTheme(welcome);
    else panel.hidden = true;
  }

  #setTheme(welcome: boolean) {
    this.#themeKnown = true;
    this.#panel!.toggleAttribute("data-welcome-theme", welcome);
    if (this.dataset.logoUrl) this.#logo!.src = brandLogoUrl(this.dataset.logoUrl, welcome);
    this.#showPanel();
  }

  #showPanel() {
    const open = this.#open && this.#themeKnown;
    this.#panel!.hidden = !open;
    document.documentElement.toggleAttribute("data-roman-open", open);
    if (open) {
      document.head.append(this.#layout!);
    } else {
      this.#layout?.remove();
    }
    document[open ? "addEventListener" : "removeEventListener"]("focusin", this.#onFocus);
  }

  #setOpen(open: boolean, focus = true) {
    if (!this.isConnected || this.#open === open) return;
    focus ||= !open && !!this.#panel?.contains(this.shadowRoot!.activeElement);
    this.#open = open;
    if (!open) this.#visualizationPath = undefined;
    savedState(open ? "1" : "0");
    if (open && !this.#panel) this.#createPanel();
    this.#showPanel();
    this.#headerLauncher?.setOpen(open);
    this.#runtime?.setOpen(open);
    if (open) {
      this.#closeButton?.focus(focusOptions);
      this.#runtime?.focus();
    } else if (focus) this.#headerLauncher?.focus();
    if (open && this.#state === "idle") void this.#start();
  }

  async #start(retry = false) {
    if (this.#state === "loading" || this.#state === "ready") return;
    if (!this.#panel) this.#createPanel();
    loadingStartedAt ??= performance.now();
    const generation = ++this.#generation;
    this.#state = "loading";
    this.#panel!.ariaBusy = "true";
    this.#loading!.hidden = false;
    this.#progress!.hidden = false;
    this.#error!.hidden = true;
    if (this.shadowRoot?.activeElement === this.#retryButton)
      this.#closeButton?.focus();
    this.#retryButton!.hidden = true;
    try {
      if (
        !this.dataset.logoUrl ||
        (!import.meta.env.DEV && !this.dataset.scriptUrl)
      )
        throw new Error("Roman assets missing. Refresh.");
      const module = await loadRuntime(this.dataset.scriptUrl || "", retry);
      if (!this.isConnected || generation !== this.#generation) return;
      const runtime = module.mountAssistant(
        this,
        this.#content!,
        loadingStartedAt,
        (welcome) => this.#setTheme(welcome),
      );
      this.#runtime = runtime;
      runtime.setOpen(this.#open);
      await runtime.ready;
      if (!this.isConnected || generation !== this.#generation) return;
      this.#state = "ready";
      this.#content!.hidden = false;
      this.#loading!.hidden = true;
      this.#panel!.ariaBusy = "false";
      runtime.focus();
      this.#launchVisualization();
    } catch (error) {
      if (!this.isConnected || generation !== this.#generation) return;
      this.#runtime?.dispose();
      this.#runtime = undefined;
      this.#content!.replaceChildren();
      this.#state = "error";
      if (!this.#themeKnown) this.#setTheme(false);
      this.#panel!.ariaBusy = "false";
      this.#progress!.hidden = true;
      this.#error!.textContent =
        error instanceof Error ? error.message : startError;
      this.#error!.hidden = false;
      this.#retryButton!.hidden = false;
    }
  }

  disconnectedCallback() {
    queueMicrotask(() => {
      if (this.isConnected) return;
      ++this.#generation;
      window.removeEventListener("pageshow", this.#onPageShow);
      document.removeEventListener("click", this.#onVisualizationClick);
      this.#visualizationPath = undefined;
      document.removeEventListener("focusin", this.#onFocus);
      this.#headerLauncher?.dispose();
      this.#headerLauncher = undefined;
      this.#runtime?.dispose();
      this.#runtime = undefined;
      this.#layout?.remove();
      document.documentElement.removeAttribute("data-roman-open");
      this.shadowRoot?.replaceChildren();
      this.#panel = undefined;
      this.#themeKnown = false;
      this.#open = false;
      this.#state = "idle";
    });
  }
}

if (!customElements.get("roman-ai-assistant"))
  customElements.define("roman-ai-assistant", RomanAssistant);
