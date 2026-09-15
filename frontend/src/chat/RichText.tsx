import { useMemo } from "react";
import Markdown, { type Components } from "react-markdown";
import type { StorefrontNavigation } from "../navigation/shared";
import { StorefrontLink } from "./StorefrontLink";

const allowedElements = [
  "p",
  "br",
  "strong",
  "em",
  "ul",
  "ol",
  "li",
  "a",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "pre",
  "code",
  "hr",
];

export function RichText({
  text,
  navigation,
}: {
  text: string;
  navigation: StorefrontNavigation;
}) {
  // Keep link components stable while streamed text updates, preserving focus.
  const components = useMemo<Components>(
    () => ({
      a: ({ href, children }) =>
        href?.trim() ? (
          <StorefrontLink url={href} navigation={navigation}>
            {children}
          </StorefrontLink>
        ) : (
          <span>{children}</span>
        ),
    }),
    [navigation],
  );

  return (
    <div className="roman-rich-text">
      <Markdown
        skipHtml
        allowedElements={allowedElements}
        components={components}
      >
        {text}
      </Markdown>
    </div>
  );
}
