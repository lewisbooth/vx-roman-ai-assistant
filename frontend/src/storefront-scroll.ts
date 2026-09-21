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
  const previous = new Map<string, [string, string]>();
  const applied = new Map<string, string>();

  function write(name: string, value: string) {
    if (!body) return;
    if (!previous.has(name))
      previous.set(name, [
        body.style.getPropertyValue(name),
        body.style.getPropertyPriority(name),
      ]);
    body.style.setProperty(name, value, "important");
    applied.set(name, value);
  }

  function scrollTo(next: [number, number]) {
    if (!position) return nativeStorefrontScroll.scrollTo(next);
    position = [Math.max(0, next[0]), Math.max(0, next[1])];
    write("left", `${-position[0]}px`);
    write("top", `${-position[1]}px`);
  }

  function setLocked(locked: boolean) {
    if (locked === !!position) return;
    if (locked) {
      position = nativeStorefrontScroll.getPosition();
      body = document.body;
      // overflow:hidden alone lets iOS pan the document behind its keyboard.
      write("position", "fixed");
      write("width", "100%");
      scrollTo(position);
    } else {
      const destination = position!;
      position = undefined;
      for (const [name, [value, priority]] of previous) {
        if (
          body &&
          body.style.getPropertyValue(name) === applied.get(name) &&
          body.style.getPropertyPriority(name) === "important"
        ) {
          if (value) body.style.setProperty(name, value, priority);
          else body.style.removeProperty(name);
        }
      }
      previous.clear();
      applied.clear();
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
