/** The theme owns its header; this trigger never owns the sidebar or runtime. */
export function attachHeaderLauncher(
  fallback: HTMLButtonElement,
  css: string,
  onClick: () => void,
  logoUrl: string,
) {
  const host = document.createElement("span");
  host.dataset.romanHeaderLauncher = "";
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = css;
  const button = fallback.cloneNode(true) as HTMLButtonElement;
  button.className = "roman-header-button";
  button.innerHTML = 'Ask <img alt="Roman">';
  (button.lastChild as HTMLImageElement).src = logoUrl;
  button.addEventListener("click", onClick);
  shadow.append(style, button);
  const sync = () => {
    const account = document.querySelector<HTMLElement>(
      'main-header .header__utilities > [data-testid="menu-account-link"]',
    );
    const visible =
      !!account &&
      !!account.getClientRects().length &&
      getComputedStyle(account).visibility !== "hidden";
    if (visible) {
      if (account!.previousElementSibling !== host) account!.before(host);
      button.style.height = `${account!.offsetHeight}px`;
    } else host.remove();
    fallback.hidden = visible;
    button.setAttribute(
      "aria-expanded",
      fallback.getAttribute("aria-expanded")!,
    );
  };
  const observer = new MutationObserver(sync);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "style", "hidden"],
  });
  window.addEventListener("resize", sync);
  sync();
  return {
    sync,
    focus() {
      (host.isConnected ? button : fallback).focus();
    },
    dispose() {
      observer.disconnect();
      window.removeEventListener("resize", sync);
      button.removeEventListener("click", onClick);
      host.remove();
      fallback.hidden = false;
    },
  };
}
