import type { ReactNode } from "react";
import { parseProductGuideUrl } from "../../../shared/product-guides";
import type { StorefrontNavigation } from "../navigation/shared";
import { GuideLink } from "./GuideLink";

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
  try {
    const guideUrl = parseProductGuideUrl(url, window.location.origin);
    return (
      <GuideLink url={guideUrl} className={className}>
        {children}
      </GuideLink>
    );
  } catch {
    // Only verified guide locations may leave the storefront. Ordinary pages
    // retain in-place navigation; arbitrary external links remain plain text.
  }
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
