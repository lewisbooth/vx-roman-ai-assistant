export function prepareCartContinue(
  source: Document,
  url: URL,
  mode: "back" | "back-or-home",
): void {
  if (url.pathname !== "/cart") return;
  for (const button of source.querySelectorAll<HTMLButtonElement>(
    "main#main button[onclick]",
  )) {
    const code = button.getAttribute("onclick")!.replace(/\s+/g, "");
    let supported = mode === "back" && /^history\.back\(\);?$/.test(code);
    if (mode === "back-or-home") {
      const match =
        /^if\(history\.length>1\)\{history\.back\(\);?\}else\{window\.location\.href=(["'])([^"']+)\1;?\}$/.exec(
          code,
        );
      if (match) {
        const home = URL.canParse(match[2], url)
          ? new URL(match[2], url)
          : null;
        supported =
          !!home &&
          home.origin === url.origin &&
          home.pathname === "/" &&
          !home.search &&
          !home.hash &&
          !home.username &&
          !home.password;
      }
    }
    if (!supported) continue;
    // Retain a usable native Home link if Roman is later removed from the page.
    const link = source.createElement("a");
    for (const attribute of button.attributes) {
      if (attribute.name !== "onclick" && attribute.name !== "type") {
        link.setAttribute(attribute.name, attribute.value);
      }
    }
    link.href = "/";
    link.dataset.romanBack = "";
    link.append(...button.childNodes);
    button.replaceWith(link);
  }
}
