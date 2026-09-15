import type { GuidePart } from "../../../shared/conversation";
import {
  parseGuidePart,
  PRODUCT_GUIDE_LABELS,
} from "../../../shared/product-guides";

export function GuideCards({ part }: { part: GuidePart }) {
  let guides: GuidePart["guides"];
  try {
    guides = parseGuidePart(part, window.location.origin).guides;
  } catch {
    return (
      <p className="roman-products-status">
        These product guides are unavailable.
      </p>
    );
  }
  return (
    <div className="roman-guides">
      <ul className="roman-guide-list" aria-label="Product guides">
        {guides.map((guide) => (
          <li key={guide.kind}>
            <a
              className="roman-guide-card"
              href={guide.url}
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
              <span>{PRODUCT_GUIDE_LABELS[guide.kind]}</span>
              <span className="roman-guide-format">
                PDF · opens in a new tab
              </span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
