/** JSON.parse discards duplicate keys. Reject them while reading config and
 * protocol inputs so a later field cannot silently replace a reviewed one. */
export class DuplicateJsonField extends SyntaxError {
  constructor(readonly field: string) { super(`Duplicate field: ${field}`); }
}
export function parseUniqueJson(source: string): unknown {
  const parsed: unknown = JSON.parse(source);
  let at = 0;
  const space = () => { while (/[\t\n\r ]/.test(source[at] ?? "\0")) at++; };
  const string = () => {
    const start = at++;
    while (at < source.length) {
      const c = source[at++];
      if (c === "\\") at++;
      else if (c === '"') return JSON.parse(source.slice(start, at)) as string;
    }
    throw new SyntaxError("Unterminated string");
  };
  const value = (depth: number, path: string): void => {
    if (depth > 128) throw new SyntaxError("JSON nesting limit exceeded");
    space(); const c = source[at];
    if (c === '"') { string(); return; }
    if (c === "{") {
      at++; space(); const keys = new Set<string>();
      if (source[at] === "}") { at++; return; }
      for (;;) {
        space(); const key = string(), field = path ? `${path}.${key}` : key;
        if (keys.has(key)) throw new DuplicateJsonField(field); keys.add(key);
        space(); at++; value(depth + 1, field); space();
        if (source[at++] === "}") return;
      }
    }
    if (c === "[") {
      at++; space(); if (source[at] === "]") { at++; return; }
      for (;;) { value(depth + 1, path); space(); if (source[at++] === "]") return; }
    }
    while (at < source.length && !/[\s,\]}]/.test(source[at]!)) at++;
  };
  value(0, "");
  return parsed;
}
