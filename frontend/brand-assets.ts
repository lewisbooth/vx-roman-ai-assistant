/** Keep one path source per logo; only burgundy lettering changes on dark UI. */
export function ivoryLogo(source: string): string {
  return source.replaceAll('fill="#4E0E0E"', 'fill="#F7F5EF"');
}
