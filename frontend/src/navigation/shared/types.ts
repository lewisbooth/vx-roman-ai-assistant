export type Destination = { label: string; path: string };

export type ThemePageHooks = {
  modules?: URL[];
  load?: (signal: AbortSignal) => Promise<void>;
};

export type StorefrontTheme = {
  id: string;
  prepare: (source: Document, url: URL) => ThemePageHooks;
  preserve?: (main: HTMLElement) => void;
};

export type StorefrontStore = {
  shop: string;
  destinations: readonly Destination[];
  theme: StorefrontTheme;
};
