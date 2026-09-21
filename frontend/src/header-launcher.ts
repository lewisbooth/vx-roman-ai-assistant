/** The theme owns its header; this trigger never owns the sidebar or runtime. */
export function attachHeaderLauncher(
  fallback: HTMLButtonElement,
  style: HTMLStyleElement,
  onClick: () => void,
  wordmarkUrl: string,
) {
  const host = document.createElement("span");
  host.dataset.romanHeaderLauncher = "";
  const shadow = host.attachShadow({ mode: "open" });
  const button = fallback.cloneNode(true) as HTMLButtonElement;
  button.className = "roman-header-button";
  button.innerHTML = "Ask <img alt=Roman>";
  (button.lastChild as HTMLImageElement).src = wordmarkUrl;
  button.onclick = onClick;
  shadow.append(style.cloneNode(true), button);
  let search: HTMLElement | null = null;
  let inView = false;
  let active = false;
  const update = () => {
    fallback.hidden = !active || inView;
  };
  const intersection = new IntersectionObserver((entries) => {
    const entry = entries.find((entry) => entry.target === search);
    if (entry) {
      inView = entry.isIntersecting;
      update();
    }
  });
  const sync = () => {
    let next = document.querySelector<HTMLElement>(
      "main-header [data-testid=menu-search-input]",
    );
    if (
      next &&
      (!next.getClientRects().length ||
        getComputedStyle(next).visibility === "hidden")
    )
      next = null;
    if (next !== search) {
      intersection.disconnect();
      search = next;
      inView = !!search;
      if (search) intersection.observe(search);
    }
    if (search) {
      const field = search.parentElement!;
      if (field.nextElementSibling !== host) field.after(host);
      button.style.height = `${search.offsetHeight}px`;
    } else host.remove();
    update();
    button.ariaExpanded = fallback.ariaExpanded;
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
    sync,
    setActive(value: boolean) {
      active = value;
      update();
    },
    focus() {
      (fallback.hidden ? button : fallback).focus({ preventScroll: true });
    },
    dispose() {
      observer.disconnect();
      intersection.disconnect();
      search = null;
      window.removeEventListener("resize", sync);
      button.onclick = null;
      host.remove();
      fallback.hidden = true;
    },
  };
}
