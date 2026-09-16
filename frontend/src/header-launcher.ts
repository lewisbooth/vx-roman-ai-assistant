/** The theme owns its header; this trigger never owns the sidebar or runtime. */
export function attachHeaderLauncher(
  fallback: HTMLButtonElement,
  css: string,
  onClick: () => void,
) {
  const host = document.createElement("span");
  host.dataset.romanHeaderLauncher = "";
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = css;
  const button = fallback.cloneNode(true) as HTMLButtonElement;
  button.classList.add("roman-header-button");
  button.addEventListener("click", onClick);
  shadow.append(style, button);
  let frame = 0;

  const sync = () => {
    const account = [
      ...document.querySelectorAll<HTMLElement>(
        'main-header .header__utilities > [data-testid="menu-account-link"]',
      ),
    ].find(
      (element) =>
        element.getClientRects().length &&
        getComputedStyle(element).visibility !== "hidden",
    );
    if (account) {
      if (account.nextElementSibling !== host) account.after(host);
    } else host.remove();
    fallback.hidden = !!account;
    button.setAttribute(
      "aria-expanded",
      fallback.getAttribute("aria-expanded")!,
    );
  };
  const schedule = () => {
    if (!frame)
      frame = requestAnimationFrame(() => {
        frame = 0;
        sync();
      });
  };
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "style", "hidden"],
  });
  window.addEventListener("resize", schedule);
  sync();
  return {
    sync,
    focus() {
      (host.isConnected ? button : fallback).focus();
    },
    dispose() {
      observer.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      button.removeEventListener("click", onClick);
      host.remove();
      fallback.hidden = false;
    },
  };
}
