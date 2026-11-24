/** Provider-neutral model-facing data. All limits include serialized JSON. */
export interface WebHit { title: string | null; url: string; excerpt: string | null }
export interface WebPage { url: string; title: string | null; text: string; truncated: boolean; coverage: "full" | "partial" | "unknown" }
export const WEB_PREVIEW_BYTES = 2048;
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

/** Longest scalar-aligned prefix which makes the complete object fit. */
function fitText(value: string, fits: (prefix: string) => boolean): string | undefined {
  const scalars = Array.from(value); let low = 0, high = scalars.length;
  if (!fits("")) return undefined;
  while (low < high) { const mid = Math.ceil((low + high) / 2); if (fits(scalars.slice(0, mid).join(""))) low = mid; else high = mid - 1; }
  return scalars.slice(0, low).join("");
}
export function truncateUtf8(value: string, max: number): string {
  return fitText(value, prefix => Buffer.byteLength(prefix) <= max) ?? "";
}
export function searchPreview(hits: readonly WebHit[], maxHits = 5, excerptBytes = 512): string {
  const results: WebHit[] = [];
  for (const original of hits.slice(0, maxHits)) {
    const hit = { ...original, excerpt: original.excerpt === null ? null : truncateUtf8(original.excerpt, excerptBytes) };
    const candidate = () => ({ results: [...results, hit] });
    if (size(candidate()) > WEB_PREVIEW_BYTES && hit.excerpt !== null)
      hit.excerpt = fitText(hit.excerpt, prefix => size({ results: [...results, { ...hit, excerpt: prefix }] }) <= WEB_PREVIEW_BYTES) ?? null;
    if (size(candidate()) > WEB_PREVIEW_BYTES && hit.title !== null)
      hit.title = fitText(hit.title, prefix => size({ results: [...results, { ...hit, title: prefix }] }) <= WEB_PREVIEW_BYTES) ?? null;
    if (size(candidate()) > WEB_PREVIEW_BYTES) break;
    results.push(hit);
  }
  return JSON.stringify({ results });
}
export function fetchPreview(input: WebPage): string | undefined {
  const page = { ...input }; const fits = () => size(page) <= WEB_PREVIEW_BYTES;
  if (fits()) return JSON.stringify(page);
  page.truncated = true;
  if (page.title !== null) {
    const original = page.title;
    page.title = fitText(original, prefix => size({ ...page, title: prefix, text: "" }) <= WEB_PREVIEW_BYTES) ?? null;
  }
  const original = page.text;
  const text = fitText(original, prefix => size({ ...page, text: prefix }) <= WEB_PREVIEW_BYTES);
  if (text === undefined) return undefined;
  page.text = text;
  return JSON.stringify(page);
}
