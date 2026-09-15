export type ThemePageHooks = {
  modules?: URL[];
};

export type StorefrontTheme = {
  id: string;
  prepare: (source: Document, url: URL) => ThemePageHooks;
};

export type StorefrontStore = {
  shop: string;
  theme: StorefrontTheme;
};
