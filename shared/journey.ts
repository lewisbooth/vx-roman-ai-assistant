/** Public page observations exclude account/checkout routes and URL metadata. */
export function isStorefrontPagePath(path: string, origin: string): boolean {
  const unsafeCharacters = (value: string) => [...value].some((character) => character === "\\" || character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
  try {
    if (!path.startsWith("/") || path.startsWith("//") || path.length > 2048 || /[?#]/.test(path) || unsafeCharacters(path)) return false;
    const url = new URL(path, origin);
    const decoded = decodeURIComponent(url.pathname);
    return url.origin === origin && url.pathname === path && !unsafeCharacters(decoded) && !/[?#]/.test(decoded) &&
      !decoded.split("/").some((segment) => ["account", "checkout", "checkouts", "challenge", "password"].includes(segment.toLowerCase()));
  } catch { return false; }
}
