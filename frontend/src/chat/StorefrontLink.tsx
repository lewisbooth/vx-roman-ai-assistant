import { useContext, type ReactNode } from "react";
import { RomanViewContext } from "./views";
import type { StorefrontNavigation } from "../navigation/shared";
import { readStoreSupport } from "../tools/store-support";

/** PDF sources stay in model context and the admin audit, never customer links. */
export function isPdfLink(url: string): boolean {
  try {
    return /\.pdf$/i.test(new URL(url, window.location.origin).pathname);
  } catch {
    return false;
  }
}

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
  const showView = useContext(RomanViewContext);
  if (isPdfLink(url)) return null;
  let href: string | undefined;
  try {
    const target = new URL(url, window.location.origin);
    // Product choice goes through Roman so a replacement can be confirmed.
    // Historical prose links cannot bypass that conversation.
    if (/(?:^|\/)(?:products|collections)(?:\/|$)/i.test(target.pathname))
      return <span className={className}>{children}</span>;
    if (
      target.origin === window.location.origin &&
      /^https?:$/.test(target.protocol) &&
      !target.username &&
      !target.password
    )
      href = target.href;
    else if (
      target.protocol === "https:" &&
      !target.username &&
      !target.password &&
      readStoreSupport().contactUrl === target.href
    )
      return (
        <a
          href={target.href}
          className={className}
          target="_blank"
          rel="noopener noreferrer"
        >
          {children}
        </a>
      );
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
        if (
          showView &&
          /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?cart\/?$/i.test(
            new URL(href).pathname,
          )
        ) {
          showView("cart");
          return;
        }
        void navigation.navigate(href);
      }}
    >
      {children}
    </a>
  );
}
