/** Select the generated lettering palette without recolouring its gold star. */
export function brandLogoUrl(url: string, ivory = false): string {
  return url.replace(
    /(?:-ivory)?\.svg(?=[?#]|$)/,
    ivory ? "-ivory.svg" : ".svg",
  );
}
