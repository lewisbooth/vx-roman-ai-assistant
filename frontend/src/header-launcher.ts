/** The theme owns its header; this trigger never owns the assistant or runtime. */
export function attachHeaderLauncher(
  style: HTMLStyleElement,
  onClick: () => void,
  wordmarkUrl: string,
  label: string,
) {
  const host = document.createElement("span");
  host.dataset.romanHeaderLauncher = "";
  const shadow = host.attachShadow({ mode: "open" });
  const button = document.createElement("button");
  button.type = "button";
  button.ariaLabel = label;
  button.ariaExpanded = "false";
  button.className = "roman-header-button";
  button.innerHTML = "Ask <img alt=Roman>";
  (button.lastChild as HTMLImageElement).src = wordmarkUrl;
  button.onclick = onClick;
  shadow.append(style.cloneNode(true), button);
  const sync = () => {
    let search = document.querySelector<HTMLElement>(
      "main-header [data-testid=menu-search-input]",
    );
    if (
      search &&
      (!search.getClientRects().length ||
        getComputedStyle(search).visibility === "hidden")
    )
      search = null;
    if (search) {
      const field = search.parentElement!;
      if (field.nextElementSibling !== host) field.after(host);
      button.style.height = `${search.offsetHeight}px`;
    } else host.remove();
  };
  const observer = new MutationObserver(sync);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributeFilter: ["class", "style", "hidden"],
  });
  window.addEventListener("resize", sync);
  sync();
  return {
    setOpen(open: boolean) {
      button.ariaExpanded = String(open);
      sync();
    },
    focus() {
      sync();
      if (host.isConnected) button.focus({ preventScroll: true });
    },
    dispose() {
      observer.disconnect();
      window.removeEventListener("resize", sync);
      button.onclick = null;
      host.remove();
    },
  };
}
