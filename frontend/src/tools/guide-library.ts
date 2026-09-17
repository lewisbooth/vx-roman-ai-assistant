import {
  GUIDE_LIBRARY_DIAGRAM_NOTICE,
  GUIDE_LIBRARY_PATHS,
  parseGuideLibraryCall,
  parseGuideLibraryResult,
  type GuideLibrary,
  type GuideLibraryResult,
} from "../../../shared/guide-library";
import { parseProductGuideUrl } from "../../../shared/product-guides";

const maxBytes = 1024 * 1024;
const ignored =
  "script,style,template,noscript,nav,form,iframe,object,embed,svg,img,video,audio,[hidden],[aria-hidden=true]";
const normalize = (value: string) => value.replace(/\s+/g, " ").trim();

async function sourceHtml(path: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(
    () => controller.abort(new Error("Guide library request timed out.")),
    10_000,
  );
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const cancel = () => {
    void reader?.cancel().catch(() => undefined);
  };
  controller.signal.addEventListener("abort", cancel, { once: true });
  try {
    const url = new URL(path, window.location.origin);
    if (url.protocol !== "https:")
      throw new Error("Guide libraries require a secure storefront.");
    const response = await fetch(url.href, {
      credentials: "same-origin",
      redirect: "error",
      signal: controller.signal,
      headers: { Accept: "text/html" },
    });
    reader = response.body?.getReader();
    controller.signal.throwIfAborted();
    if (
      !response.ok ||
      response.redirected ||
      (response.url && response.url !== url.href) ||
      response.headers
        .get("content-type")
        ?.split(";", 1)[0]
        .trim()
        .toLowerCase() !== "text/html" ||
      !reader
    )
      throw new Error("The store's guide library could not be read.");
    const size = response.headers.get("content-length");
    if (size && (!/^\d+$/.test(size) || Number(size) > maxBytes))
      throw new Error("The guide library exceeds the page limit.");
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let html = "",
      bytes = 0;
    for (;;) {
      const next = await reader.read();
      controller.signal.throwIfAborted();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes)
        throw new Error("The guide library exceeds the page limit.");
      html += decoder.decode(next.value, { stream: true });
    }
    return html + decoder.decode();
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", cancel);
    cancel();
    reader?.releaseLock();
  }
}

async function identity(prefix: "s" | "g", value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return `${prefix}_${[...new Uint8Array(bytes)]
    .slice(0, 12)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
}

/** Read source content inertly; never adopt theme elements or load their resources. */
export async function discoverGuides(
  library: GuideLibrary,
  signal: AbortSignal,
): Promise<GuideLibraryResult> {
  parseGuideLibraryCall({ library });
  const origin = window.location.origin;
  const html = await sourceHtml(GUIDE_LIBRARY_PATHS[library], signal);
  signal.throwIfAborted();
  const template = document.createElement("template");
  template.innerHTML = html;
  const mains = template.content.querySelectorAll("main#main");
  const primary =
    mains.length === 1
      ? mains[0].querySelectorAll(':scope > .shopify-section[id$="__main"]')
      : [];
  const titles = primary.length === 1 ? primary[0].querySelectorAll("h1") : [];
  const content =
    primary.length === 1 ? primary[0].querySelectorAll(".rte") : [];
  if (titles.length !== 1 || content.length !== 1)
    throw new Error(
      "The store's guide library content is unavailable or ambiguous.",
    );
  const title = normalize(titles[0].textContent ?? "");
  content[0].querySelectorAll(ignored).forEach((element) => element.remove());
  const sections: {
    title: string;
    paragraphs: string[];
    links: { title: string; url: string }[];
  }[] = [];
  let current = {
    title,
    paragraphs: [] as string[],
    links: [] as { title: string; url: string }[],
  };
  let line = "";
  const flush = () => {
    const text = normalize(line);
    if (text) current.paragraphs.push(text);
    line = "";
  };
  const finish = () => {
    flush();
    if (current.paragraphs.length || current.links.length)
      sections.push(current);
  };
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      line += node.textContent ?? "";
      return;
    }
    if (!(node instanceof Element)) return;
    if (node.tagName === "TABLE") {
      const rows = [...node.querySelectorAll("tr")].filter(
        (row) => row.closest("table") === node,
      );
      const first = rows[0] ? [...rows[0].children] : [];
      // The library's bay links are arranged in heading columns, not rows.
      // Traverse a column only when native cells establish its ownership.
      if (
        first.length > 1 &&
        first.every((cell) => {
          const headings = cell.querySelectorAll("h1,h2,h3,h4,h5,h6");
          return (
            headings.length === 1 &&
            normalize(headings[0].textContent ?? "") &&
            normalize(cell.textContent ?? "") ===
              normalize(headings[0].textContent ?? "")
          );
        })
      ) {
        if (
          first.length > 4 ||
          rows.some(
            (row) =>
              row.children.length !== first.length ||
              [...row.children].some(
                (cell) =>
                  !["TD", "TH"].includes(cell.tagName) ||
                  (cell.hasAttribute("colspan") &&
                    cell.getAttribute("colspan") !== "1") ||
                  (cell.hasAttribute("rowspan") &&
                    cell.getAttribute("rowspan") !== "1"),
              ),
          )
        )
          throw new Error("The guide library has an ambiguous table layout.");
        flush();
        for (let column = 0; column < first.length; column++)
          for (const row of rows) walk(row.children[column]);
        flush();
        return;
      }
    }
    if (/^H[1-6]$/.test(node.tagName)) {
      const heading = normalize(node.textContent ?? "");
      if (heading) {
        finish();
        current = { title: heading, paragraphs: [], links: [] };
      }
      return;
    }
    if (node.tagName === "A") {
      try {
        const url = parseProductGuideUrl(node.getAttribute("href"), origin);
        const label = normalize(node.textContent ?? "");
        if (
          label &&
          !current.links.some(
            (link) => link.url === url && link.title === label,
          )
        )
          current.links.push({ title: label, url });
      } catch {
        /* Non-PDF links stay plain source text, never navigation targets. */
      }
    }
    const block =
      /^(?:P|DIV|UL|OL|LI|TABLE|TBODY|THEAD|TFOOT|TR|TD|TH|BR|SECTION|ARTICLE|MAIN|BLOCKQUOTE)$/.test(
        node.tagName,
      );
    if (block) flush();
    // Preserve simple data-table columns together; layout tables still traverse
    // their nested headings, lists and paragraphs in source order.
    if (
      node.tagName === "TR" &&
      node.children.length > 1 &&
      [...node.children].every(
        (cell) =>
          ["TD", "TH"].includes(cell.tagName) &&
          !cell.querySelector("h1,h2,h3,h4,h5,h6,p,ul,ol,table,a"),
      )
    ) {
      line += [...node.children]
        .map((cell) => normalize(cell.textContent ?? ""))
        .join(" | ");
    } else node.childNodes.forEach(walk);
    if (block) flush();
  };
  content[0].childNodes.forEach(walk);
  finish();
  if (
    sections.length > 48 ||
    sections.reduce((sum, section) => sum + section.links.length, 0) > 40
  )
    throw new Error("The guide library exceeds its section or link limit.");
  const result: GuideLibraryResult = {
    library,
    pagePath: GUIDE_LIBRARY_PATHS[library],
    title,
    sections: [],
    guides: [],
    diagramNotice: GUIDE_LIBRARY_DIAGRAM_NOTICE,
  };
  for (let index = 0; index < sections.length; index++) {
    signal.throwIfAborted();
    const section = sections[index],
      text = section.paragraphs.join("\n\n");
    const id = await identity("s", [library, index, section.title, text]);
    result.sections.push({ id, title: section.title, text });
    for (const link of section.links)
      result.guides.push({
        id: await identity("g", [library, id, link.title, link.url]),
        ...link,
        section: id,
      });
  }
  signal.throwIfAborted();
  if (window.location.origin !== origin)
    throw new Error("The storefront changed while reading its guides.");
  return parseGuideLibraryResult(result, origin);
}
