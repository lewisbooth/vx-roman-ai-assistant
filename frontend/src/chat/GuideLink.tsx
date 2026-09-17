import type { ReactNode } from "react";

/** Callers validate the file URL with the shared guide contract before rendering. */
export function GuideLink({
  url,
  children,
  className,
}: {
  url: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <a
      className={`roman-guide-card${className ? ` ${className}` : ""}`}
      href={url}
      target="_blank"
      rel="noopener noreferrer"
    >
      <svg
        viewBox="0 0 24 24"
        width="24"
        height="24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        aria-hidden="true"
      >
        <path d="M7 3h7l4 4v14H7zM14 3v5h4M10 12h5M10 16h5" />
      </svg>
      <span>{children}</span>
      <span className="roman-guide-format">PDF · opens in a new tab</span>
    </a>
  );
}
