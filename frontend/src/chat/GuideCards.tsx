import type { GuidePart } from "../../../shared/conversation";
import {
  parseGuidePart,
  PRODUCT_GUIDE_LABELS,
} from "../../../shared/product-guides";
import { GuideLink } from "./GuideLink";

export function GuideCards({ part }: { part: GuidePart }) {
  let guides: GuidePart["guides"];
  try {
    guides = parseGuidePart(part, window.location.origin).guides;
  } catch {
    return (
      <p className="roman-products-status">
        These {part.version === 2 ? "library" : "product"} guides are
        unavailable.
      </p>
    );
  }
  return (
    <div className="roman-guides">
      <ul
        className="roman-guide-list"
        aria-label={part.version === 2 ? "Library guide" : "Product guides"}
      >
        {guides.map((guide) => (
          <li key={guide.kind}>
            <GuideLink url={guide.url}>
              {PRODUCT_GUIDE_LABELS[guide.kind]}
            </GuideLink>
          </li>
        ))}
      </ul>
    </div>
  );
}
