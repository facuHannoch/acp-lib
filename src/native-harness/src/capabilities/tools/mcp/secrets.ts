/** Lifetime is one connection. Values never leave this closure. */
export function mcpSecrets(values: readonly string[]) {
  const secrets = [...new Set(values.filter(Boolean))].sort((a, b) => b.length - a.length);
  const contains = (text: string) => secrets.some(secret => text.includes(secret));
  const pattern = secrets.length ? new RegExp(secrets.map(secret => secret.replace(/[.*+?^$\{\}()|[\]\\]/g, "\\$&")).join("|"), "g") : undefined;
  function text(value: string): string {
    if (!pattern) return value;
    const projected = value.replace(pattern, "[redacted]");
    // Overlapping matches or short credentials can make the marker unsafe.
    if (contains(projected)) throw new Error("MCP output could not be safely redacted");
    return projected;
  }
  function tree(value: unknown, checkOnly = false, depth = 0): unknown {
    if (depth > 64) throw new Error("MCP output nesting exceeds limit");
    if (typeof value === "string") {
      if (!checkOnly) return text(value);
      if (contains(value)) throw new Error("MCP definition contains credential material");
      return value;
    }
    if (Array.isArray(value)) return value.map(item => tree(item, checkOnly, depth + 1));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
      if (contains(key)) throw new Error("MCP output key contains credential material");
      return [key, tree(entry, checkOnly, depth + 1)];
    }));
    return value;
  }
  return { contains, text, tree };
}
