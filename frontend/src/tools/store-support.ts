import {
  parseStoreSupportResult,
  type StoreSupportResult,
} from "../../../shared/store-support";

const normalize = (value: string | null) =>
  value?.replace(/\s+/g, " ").trim() ?? "";
const contactLabel =
  /^(?:contact(?: us)?|customer (?:service|support)|get in touch)$/i;
const excluded =
  "form,script,style,template,noscript,[hidden],[aria-hidden=true]";
const phoneText = (value: string) =>
  /^\+?[\d ().-]+$/.test(value) && /^\d{6,18}$/.test(value.replace(/\D/g, ""));
const hoursText = (value: string) =>
  value.length <= 160 &&
  /(?:\d\s*(?:am|pm)\b|\b(?:hours|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun|days? a week)\b)/i.test(
    value,
  ) &&
  /\d/.test(value);

function readBlock(block: Element, copy: Element): StoreSupportResult {
  if (normalize(copy.textContent).length > 1_200)
    return { status: "unavailable" };
  const texts = [...copy.querySelectorAll("p,li,address")]
    .filter(
      (element) =>
        !element.closest(excluded) && !element.querySelector("p,li,address"),
    )
    .map((element) => normalize(element.textContent))
    .filter(Boolean);
  const phones = new Set(texts.filter(phoneText));
  const hours = new Set(texts.filter(hoursText));
  for (const anchor of block.querySelectorAll<HTMLAnchorElement>(
    'a[href^="tel:"]',
  )) {
    if (anchor.closest(excluded)) continue;
    const label = normalize(anchor.textContent),
      href = anchor.getAttribute("href")!.slice(4);
    if (
      phoneText(label) &&
      phoneText(href) &&
      label.replace(/\D/g, "") === href.replace(/\D/g, "")
    )
      phones.add(label);
  }
  const links = new Set<string>();
  for (const anchor of block.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    if (
      anchor.closest(excluded) ||
      !contactLabel.test(normalize(anchor.textContent))
    )
      continue;
    try {
      const result = parseStoreSupportResult(
        { status: "found", contactUrl: anchor.getAttribute("href") },
        window.location.origin,
      );
      links.add(result.contactUrl!);
    } catch {
      /* Invalid contact links cannot become executable URLs. */
    }
  }
  if (phones.size > 1 || hours.size > 1 || links.size > 1)
    return { status: "unavailable" };
  const details = {
    ...(phones.size ? { phone: [...phones][0] } : {}),
    ...(hours.size ? { hours: [...hours][0] } : {}),
    ...(links.size ? { contactUrl: [...links][0] } : {}),
  };
  return {
    status: Object.keys(details).length ? "found" : "unavailable",
    ...details,
  };
}

/** The contact block is the source; newsletter inputs and legal footer text are not. */
export async function getStoreSupport(
  signal: AbortSignal,
): Promise<StoreSupportResult> {
  signal.throwIfAborted();
  const roots = document.querySelectorAll("footer#main-footer");
  const footers = roots.length
    ? roots
    : document.querySelectorAll("footer,[role=contentinfo]");
  if (footers.length !== 1) return { status: "unavailable" };
  const footer = footers[0];
  const dedicated = [...footer.querySelectorAll(".text-footer-caption")].filter(
    (copy) =>
      !copy.closest(excluded) &&
      [...(copy.parentElement?.children ?? [])].some(
        (sibling) =>
          sibling !== copy &&
          sibling.matches(".text-footer-link-list-heading") &&
          contactLabel.test(normalize(sibling.textContent)),
      ),
  );
  if (dedicated.length) {
    if (dedicated.length !== 1) return { status: "unavailable" };
    return parseStoreSupportResult(
      readBlock(dedicated[0].parentElement!, dedicated[0]),
      window.location.origin,
    );
  }
  // Other themes may expose a small semantic contact/address block. Never
  // infer details by scanning or returning the full footer's text.
  const blocks = new Set<Element>();
  for (const heading of footer.querySelectorAll("h2,h3,h4,h5,h6")) {
    if (
      !heading.closest(excluded) &&
      contactLabel.test(normalize(heading.textContent)) &&
      heading.parentElement !== footer &&
      normalize(heading.parentElement!.textContent).length <= 1_200
    )
      blocks.add(heading.parentElement!);
  }
  for (const address of footer.querySelectorAll("address"))
    if (
      !address.closest(excluded) &&
      normalize(address.textContent).length <= 1_200
    )
      blocks.add(address);
  const distinct = [...blocks].filter(
    (block) =>
      ![...blocks].some((other) => other !== block && other.contains(block)),
  );
  if (distinct.length !== 1) return { status: "unavailable" };
  signal.throwIfAborted();
  return parseStoreSupportResult(
    readBlock(distinct[0], distinct[0]),
    window.location.origin,
  );
}
