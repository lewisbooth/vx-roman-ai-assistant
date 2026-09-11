import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RouterProvider } from "react-router/dom";
import { APP_NAME, ASSISTANT_INITIAL } from "../../shared/brand";
import { createAssistantRouter } from "./app";
import styles from "./styles.css?inline";

class RomanAssistant extends HTMLElement {
  private root?: Root;
  private router?: ReturnType<typeof createAssistantRouter>;

  connectedCallback() {
    if (this.root) return;

    const shadow = this.shadowRoot ?? this.attachShadow({ mode: "open" });
    const container = document.createElement("div");
    shadow.replaceChildren(container);

    this.router = createAssistantRouter({
      label: this.dataset.label || APP_NAME,
      initial: this.dataset.initial || ASSISTANT_INITIAL,
    });
    this.root = createRoot(container);
    this.root.render(
      <StrictMode>
        <style>{styles}</style>
        <RouterProvider router={this.router} />
      </StrictMode>,
    );
  }

  disconnectedCallback() {
    queueMicrotask(() => {
      if (this.isConnected) return;
      this.root?.unmount();
      this.router?.dispose();
      this.root = undefined;
      this.router = undefined;
    });
  }
}

if (!customElements.get("roman-ai-assistant")) {
  customElements.define("roman-ai-assistant", RomanAssistant);
}
