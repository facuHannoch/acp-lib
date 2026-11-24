import { BlockList, isIP } from "node:net";

export class DirectHttpError extends Error {
  constructor(readonly code: "blocked_destination" | "page_unavailable" | "unsupported_content" | "response_too_large" |
    "tool_interrupted" | "tool_timeout" | "result_too_large", message: string) { super(message); }
}

const blocked = () => new DirectHttpError("blocked_destination", "Web destination must be public.");
const nonPublic = new BlockList();
// Block special-purpose allocations conservatively, even globally reachable anycast exceptions.
// https://www.iana.org/assignments/iana-ipv4-special-registry/
// https://www.iana.org/assignments/iana-ipv6-special-registry/
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.31.196.0", 24], ["192.52.193.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["192.175.48.0", 24], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 3],
] as const) nonPublic.addSubnet(address, prefix, "ipv4");
const globalUnicast = new BlockList();
globalUnicast.addSubnet("2000::", 3, "ipv6");
for (const [address, prefix] of [
  ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["2620:4f:8000::", 48], ["3fff::", 20],
] as const) nonPublic.addSubnet(address, prefix, "ipv6");

export function publicAddress(address: string): 4 | 6 {
  const family = isIP(address);
  if (family === 4 && !nonPublic.check(address, "ipv4")) return family;
  if (family === 6 && globalUnicast.check(address, "ipv6") && !nonPublic.check(address, "ipv6")) return family;
  throw blocked();
}

export function directHostname(url: URL) {
  return url.hostname.replace(/^\[|\]$/g, "");
}

export function directUrl(input: string, previous?: URL): URL {
  if (!input || Buffer.byteLength(input) > 2048 || /[\x00-\x20\x7f\s\\#]/.test(input)) throw blocked();
  const authority = /^(?:https?:)?\/\/([^/?]+)/i.exec(input)?.[1];
  if ((!previous && !/^https?:\/\//i.test(input)) || (authority === undefined && /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(input))
      || authority?.includes("@") || authority?.includes("%")) throw blocked();
  let url: URL;
  try { url = new URL(input, previous); } catch { throw blocked(); }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.hash ||
      (previous?.protocol === "https:" && url.protocol !== "https:") || Buffer.byteLength(url.href) > 2048) throw blocked();
  const host = directHostname(url);
  const family = isIP(host);
  if (family) {
    const rawHost = authority?.replace(/:\d+$/, "");
    if (family === 4 && authority !== undefined && rawHost !== host) throw blocked();
    if (family === 6 && authority !== undefined && !rawHost?.startsWith("[")) throw blocked();
    publicAddress(host);
  } else if (!host.includes(".") || /(?:^|\.)(?:localhost|local|internal|onion|test|invalid|example|home\.arpa)\.?$/i.test(host)) {
    throw blocked();
  }
  return url;
}
