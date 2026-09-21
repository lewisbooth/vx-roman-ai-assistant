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

  function setLocked(locked: boolean) {
    if (locked === !!position) return;
    if (locked) {
      position = nativeStorefrontScroll.getPosition();
      body = document.body;
      // overflow:hidden alone lets iOS pan the document behind its keyboard.
      write(body, "position", "fixed");
      write(body, "width", "100%");
      // Safari can expose the document canvas above its keyboard. Match the
      // opaque assistant without hiding or changing the theme's controls.
      write(document.documentElement, "background-color", "#f7f5ef");
      write(document.documentElement, "background-image", "none");
      scrollTo(position);
    } else {
      const destination = position!;
      position = undefined;
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
    setLocked,
    dispose: () => setLocked(false),
  };
}
