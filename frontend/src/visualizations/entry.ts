import { currentProductPath, findCurrentProductForm } from "../tools/product-controls";

/** Native PDP identity only. Route/query text and a caller-supplied title are not authority. */
export function currentVisualizationProduct(
  path = currentProductPath(),
): { path: string; title: string } | undefined {
  if (!path || !/^\/products\/[a-z0-9][a-z0-9-]*$/i.test(path) || !findCurrentProductForm(path)) return;
  const roots = document.querySelectorAll("app-provider > main#main");
  if (roots.length !== 1) return;
  const products = roots[0].querySelectorAll('main-product[update-url="true"]');
  if (products.length > 1 || (products.length === 1 && products[0].getAttribute("product-url") !== path)) return;
  const titles = (products[0] ?? roots[0]).querySelectorAll("h1");
  const title = titles.length === 1 ? titles[0].textContent?.replace(/\s+/g, " ").trim() : undefined;
  if (!title || title.length > 200 || /\p{Cc}/u.test(title)) return;
  return { path, title };
}
