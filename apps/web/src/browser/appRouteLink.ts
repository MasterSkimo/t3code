/** Resolves a root-relative app link while rejecting protocol-relative URLs. */
export function resolveAppRouteHref(href: string): string | null {
  if (!href.startsWith("/") || href.startsWith("//")) return null;
  try {
    const url = new URL(href, "http://t3.local");
    if (url.origin !== "http://t3.local") return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}
