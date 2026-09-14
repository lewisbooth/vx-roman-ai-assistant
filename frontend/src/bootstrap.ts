import { APP_NAME, ASSISTANT_INITIAL } from "../../shared/brand";
import closeIcon from "./assets/close.svg?url";
import styles from "./bootstrap.css?inline";
import layoutCss from "./storefront.css?inline";
import type { AssistantRuntime } from "./runtime";

type RuntimeModule = {
  mountAssistant: (
    host: HTMLElement,
    container: HTMLElement,
    loadingStartedAt: number,
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
let storageUnavailable = false;

function savedOpen(open?: boolean): boolean {
  if (storageUnavailable) return false;
  try {
    if (open === undefined)
      return window.sessionStorage.getItem(visibilityKey) === "1";
    window.sessionStorage.setItem(visibilityKey, open ? "1" : "0");
    return open;
  } catch {
    storageUnavailable = true;
    console.warn(
      "[Roman] Storage unavailable; sidebar state won't survive navigation.",
    );
    return false;
  }
}

function loadRuntime(url: string, retry: boolean): Promise<RuntimeModule> {
  if (import.meta.env.DEV) return import("./main");
  if (retry && download?.failed) download = undefined;
  if (download) {
    if (download.url !== url)
      return Promise.reject(
        new Error("Roman was updated. Refresh the page to continue."),
      );
    return download.promise;
  }
  const status = { failed: false };
  const promise = new Promise<RuntimeModule>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = url;
    script.async = true;
    script.dataset.romanRuntime = "";
    const finish = (error?: Error) => {
      window.clearTimeout(timeout);
      script.onload = null;
      script.onerror = null;
      if (error) {
        status.failed = true;
        script.remove();
        reject(error);
      } else resolve(window.RomanAssistant!);
    };
    const timeout = window.setTimeout(
      () =>
        finish(
          new Error("Roman is taking too long to load. Please try again."),
        ),
      15000,
    );
    script.onload = () =>
      finish(
        typeof window.RomanAssistant?.mountAssistant === "function"
          ? undefined
          : new Error("Roman could not start. Please try again."),
      );
    script.onerror = () =>
      finish(
        new Error("Roman could not load. Check your connection and try again."),
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
      return status.failed;
    },
  };
  return promise;
}

class RomanAssistant extends HTMLElement {
  private launcher?: HTMLButtonElement;
  private panel?: HTMLElement;
  private closeButton?: HTMLButtonElement;
  private content?: HTMLDivElement;
  private loading?: HTMLDivElement;
  private progress?: HTMLDivElement;
  private error?: HTMLParagraphElement;
  private retryButton?: HTMLButtonElement;
  private layout?: HTMLStyleElement;
  private runtime?: AssistantRuntime;
  private open = false;
  private state: "idle" | "loading" | "ready" | "error" = "idle";
  private generation = 0;
  private onPageShow = (event: PageTransitionEvent) => {
    if (!event.persisted) return;
    const open = savedOpen();
    if (!storageUnavailable) this.setOpen(open, false);
  };

  connectedCallback() {
    if (this.launcher) return;
    const shadow = this.shadowRoot ?? this.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = styles;
    const launcher = document.createElement("button");
    launcher.type = "button";
    launcher.dataset.romanLauncher = "";
    launcher.setAttribute("aria-label", this.dataset.label || APP_NAME);
    launcher.setAttribute("aria-expanded", "false");
    launcher.textContent = this.dataset.initial || ASSISTANT_INITIAL;
    launcher.className = "roman-launcher";
    launcher.addEventListener("click", () => {
      console.log("Hello from Roman");
      this.setOpen(!this.open);
    });
    this.launcher = launcher;
    shadow.replaceChildren(style, launcher);
    window.addEventListener("pageshow", this.onPageShow);
    if (savedOpen()) this.setOpen(true, false);
  }

  private createPanel() {
    const panel = document.createElement("section");
    panel.id = `roman-panel-${crypto.randomUUID()}`;
    panel.dataset.romanPanel = "";
    panel.setAttribute("aria-label", this.dataset.label || APP_NAME);
    panel.className = "roman-panel";
    // Static markup only. Theme-provided URLs are assigned as DOM properties.
    panel.innerHTML = `
      <img class="roman-texture" alt="" hidden>
      <div data-roman-content class="roman-content-scroll" hidden></div>
      <div data-roman-loading class="roman-loading">
        <img class="roman-loading-logo" alt="Roman by SelectBlinds" width="178" height="75">
        <div class="roman-progress-track" role="progressbar" aria-label="Loading Roman"><div class="roman-progress"></div></div>
        <p class="roman-loading-error" role="alert" hidden></p>
        <button data-roman-retry class="roman-retry" type="button" hidden>Retry</button>
      </div>
      <button class="roman-close" type="button" aria-label="Close assistant"><img alt="" width="20" height="20"></button>`;
    const texture = panel.querySelector<HTMLImageElement>(".roman-texture")!;
    if (this.dataset.textureUrl) {
      texture.src = this.dataset.textureUrl;
      texture.hidden = false;
    }
    const logo = panel.querySelector<HTMLImageElement>(".roman-loading-logo")!;
    if (this.dataset.logoUrl) logo.src = this.dataset.logoUrl;
    panel.querySelector<HTMLImageElement>(".roman-close img")!.src = closeIcon;
    this.panel = panel;
    this.closeButton = panel.querySelector<HTMLButtonElement>(".roman-close")!;
    this.content = panel.querySelector<HTMLDivElement>("[data-roman-content]")!;
    this.loading = panel.querySelector<HTMLDivElement>("[data-roman-loading]")!;
    this.progress = panel.querySelector<HTMLDivElement>("[role=progressbar]")!;
    this.error = panel.querySelector<HTMLParagraphElement>("[role=alert]")!;
    this.retryButton =
      panel.querySelector<HTMLButtonElement>("[data-roman-retry]")!;
    this.closeButton.addEventListener("click", () => this.setOpen(false));
    this.retryButton.addEventListener("click", () => void this.start(true));
    panel.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      this.setOpen(false);
    });
    this.shadowRoot!.append(panel);
    this.launcher!.setAttribute("aria-controls", panel.id);
    const layout = document.createElement("style");
    layout.dataset.romanLayout = "";
    layout.textContent = layoutCss;
    this.layout = layout;
  }

  private setOpen(open: boolean, focus = true) {
    if (!this.isConnected || this.open === open) return;
    focus ||= !open && !!this.panel?.contains(this.shadowRoot!.activeElement);
    this.open = open;
    savedOpen(open);
    if (open && !this.panel) this.createPanel();
    this.panel!.hidden = !open;
    this.launcher!.setAttribute("aria-expanded", String(open));
    document.documentElement.toggleAttribute("data-roman-sidebar-open", open);
    if (open) document.head.append(this.layout!);
    else this.layout?.remove();
    this.runtime?.setOpen(open);
    if (focus) (open ? this.closeButton : this.launcher)?.focus();
    if (open && this.state === "idle") void this.start();
  }

  private async start(retry = false) {
    if (this.state === "loading" || this.state === "ready") return;
    loadingStartedAt ??= performance.now();
    const generation = ++this.generation;
    this.state = "loading";
    this.panel!.setAttribute("aria-busy", "true");
    this.loading!.hidden = false;
    this.progress!.hidden = false;
    this.error!.hidden = true;
    if (this.shadowRoot?.activeElement === this.retryButton)
      this.closeButton?.focus();
    this.retryButton!.hidden = true;
    try {
      if (
        !this.dataset.logoUrl ||
        (!import.meta.env.DEV && !this.dataset.scriptUrl)
      )
        throw new Error(
          "Roman's assets are not configured. Refresh the page and try again.",
        );
      const module = await loadRuntime(this.dataset.scriptUrl || "", retry);
      if (!this.isConnected || generation !== this.generation) return;
      const runtime = module.mountAssistant(
        this,
        this.content!,
        loadingStartedAt,
      );
      this.runtime = runtime;
      runtime.setOpen(this.open);
      await runtime.ready;
      if (!this.isConnected || generation !== this.generation) return;
      this.state = "ready";
      this.content!.hidden = false;
      this.loading!.hidden = true;
      this.panel!.setAttribute("aria-busy", "false");
    } catch (error) {
      if (!this.isConnected || generation !== this.generation) return;
      this.runtime?.dispose();
      this.runtime = undefined;
      this.content!.replaceChildren();
      this.state = "error";
      this.panel!.setAttribute("aria-busy", "false");
      this.progress!.hidden = true;
      this.error!.textContent =
        error instanceof Error
          ? error.message
          : "Roman could not start. Please try again.";
      this.error!.hidden = false;
      this.retryButton!.hidden = false;
    }
  }

  disconnectedCallback() {
    queueMicrotask(() => {
      if (this.isConnected) return;
      ++this.generation;
      window.removeEventListener("pageshow", this.onPageShow);
      this.runtime?.dispose();
      this.runtime = undefined;
      this.layout?.remove();
      document.documentElement.removeAttribute("data-roman-sidebar-open");
      this.shadowRoot?.replaceChildren();
      this.launcher = undefined;
      this.panel = undefined;
      this.open = false;
      this.state = "idle";
    });
  }
}

if (!customElements.get("roman-ai-assistant"))
  customElements.define("roman-ai-assistant", RomanAssistant);
