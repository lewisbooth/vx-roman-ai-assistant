import type { ReactNode } from "react";
import { parseProductGuideUrl } from "../../../shared/product-guides";
import type { StorefrontNavigation } from "../navigation/shared";

export function StorefrontLink({
  url,
  navigation,
  className,
  children,
}: {
  url: string;
  navigation: StorefrontNavigation;
  className?: string;
  children: ReactNode;
}) {
  let href: string | undefined;
  try {
    const target = new URL(url, window.location.origin);
    if (
      target.origin === window.location.origin &&
      /^https?:$/.test(target.protocol) &&
      !target.username &&
      !target.password
    )
      href = target.href;
  } catch {
    /* Invalid remote links render as text, never as an executable URL. */
  }

  if (!href) return <span className={className}>{children}</span>;
  try {
    const guideUrl = parseProductGuideUrl(href, window.location.origin);
    return (
      <a
        href={guideUrl}
        className={className}
        target="_blank"
        rel="noopener noreferrer"
      >
        {children}
      </a>
    );
  } catch {
    // Ordinary storefront pages retain in-place navigation. Store-linked PDFs
    // open separately so a Markdown guide link cannot replace active voice.
  }
  return (
    <a
      href={href}
      className={className}
      onClick={(event) => {
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        event.preventDefault();
        void navigation.navigate(href);
      }}
    >
      {children}
    </a>
  );
}
