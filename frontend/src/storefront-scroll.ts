export type StorefrontScroll = {
  getPosition: () => [number, number];
  scrollTo: (position: [number, number]) => void;
  scrollIntoView: (element: HTMLElement) => void;
};

export const nativeStorefrontScroll: StorefrontScroll = {
  getPosition: () => [window.scrollX, window.scrollY],
  scrollTo: ([left, top]) => window.scrollTo({ left, top, behavior: "instant" }),
  scrollIntoView: (element) => element.scrollIntoView(),
};

/** Freeze the document without hiding the theme's live product controls.
 * Navigation continues to own a logical scroll position until Roman closes.
 */
export function createStorefrontScroll() {
  let position: [number, number] | undefined;
  let body: HTMLElement | undefined;
  let welcome = false;
  let themeColor: HTMLMetaElement | undefined;
  const styles = new Map<
    CSSStyleDeclaration,
    Map<string, { value: string; priority: string; applied: string }>
  >();

  function write(element: HTMLElement | undefined, name: string, value: string) {
    if (!element) return;
    const style = element.style;
    let properties = styles.get(style);
    if (!properties) {
      properties = new Map();
      styles.set(style, properties);
    }
    let saved = properties.get(name);
    if (!saved) {
      saved = {
        value: style.getPropertyValue(name),
        priority: style.getPropertyPriority(name),
        applied: "",
      };
      properties.set(name, saved);
    }
    style.setProperty(name, value, "important");
    // CSSOM normalizes colors, so compare its stored value during cleanup.
    saved.applied = style.getPropertyValue(name);
  }

  function scrollTo(next: [number, number]) {
    if (!position) return nativeStorefrontScroll.scrollTo(next);
    position = [Math.max(0, next[0]), Math.max(0, next[1])];
    write(body, "left", `${-position[0]}px`);
    write(body, "top", `${-position[1]}px`);
  }

  function paintCanvas() {
    if (!position) return;
    const color = welcome ? "#4e0e0e" : "#f7f5ef";
    // Safari can expose either document surface when its keyboard or browser
    // chrome changes size. Keep both in sync with Roman's current view.
    for (const element of [document.documentElement, body]) {
      write(element, "background-color", color);
      write(element, "background-image", "none");
    }
    if (!themeColor) {
      themeColor = document.createElement("meta");
      themeColor.name = "theme-color";
      // The first matching theme-color supplies the browser chrome hint.
      // Own a temporary override instead of rewriting the store's metadata.
      document.head.prepend(themeColor);
    }
    themeColor.content = color;
  }

  function setTheme(isWelcome: boolean) {
    welcome = isWelcome;
    paintCanvas();
  }

  function setLocked(locked: boolean) {
    if (locked === !!position) return;
    if (locked) {
      position = nativeStorefrontScroll.getPosition();
      body = document.body;
      // overflow:hidden alone lets iOS pan the document behind its keyboard.
      write(body, "position", "fixed");
      write(body, "width", "100%");
      paintCanvas();
      scrollTo(position);
    } else {
      const destination = position!;
      position = undefined;
      themeColor?.remove();
      themeColor = undefined;
      for (const [style, properties] of styles) {
        for (const [name, { value, priority, applied }] of properties) {
          if (
            style.getPropertyValue(name) === applied &&
            style.getPropertyPriority(name) === "important"
          ) {
            if (value) style.setProperty(name, value, priority);
            else style.removeProperty(name);
          }
        }
      }
      styles.clear();
      body = undefined;
      nativeStorefrontScroll.scrollTo(destination);
    }
  }

  return {
    getPosition: (): [number, number] =>
      position ? [...position] : nativeStorefrontScroll.getPosition(),
    scrollTo,
    scrollIntoView(element: HTMLElement) {
      if (!position) return nativeStorefrontScroll.scrollIntoView(element);
      const margin = Number.parseFloat(getComputedStyle(element).scrollMarginTop) || 0;
      scrollTo([
        position[0],
        element.getBoundingClientRect().top + position[1] - margin,
      ]);
    },
    setTheme,
    setLocked,
    dispose: () => setLocked(false),
  };
}
