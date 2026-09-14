export type Destination = { label: string; path: string };

export type ThemePageHooks = {
  modules?: URL[];
};

export type StorefrontTheme = {
  id: string;
  prepare: (source: Document, url: URL) => ThemePageHooks;
};

export type StorefrontStore = {
  shop: string;
  destinations: readonly Destination[];
  theme: StorefrontTheme;
};
