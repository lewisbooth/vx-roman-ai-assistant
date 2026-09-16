/** Current theme page title, shared by quiet observations and confirmed tools. */
export function storefrontPageTitle(path: string): string {
  for (const candidate of [
    document.querySelector("app-provider > main#main h1")?.textContent,
    document.title,
    path,
  ]) {
    const title = candidate?.replace(/[\p{Cc}\s]+/gu, " ").trim().slice(0, 200);
    if (title) return title;
  }
  return "/";
}
