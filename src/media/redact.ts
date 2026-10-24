/** Remove inline bytes recursively before debug/protocol persistence. Never changes the wire. */
export function redactMedia<T>(value: T): T {
  if (Array.isArray(value)) return value.map(redactMedia) as T;
  if (!value || typeof value !== "object") return value;
  if (value instanceof Uint8Array) return { byteLength: value.byteLength } as T;
  const embedded = value as { uri?: unknown; text?: unknown };
  if (typeof embedded.uri === "string" && typeof embedded.text === "string") {
    return { ...value, text: { byteLength: Buffer.byteLength(embedded.text) } } as T;
  }
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key,
    (key === "data" || key === "blob") && typeof child === "string"
      ? { byteLength: Buffer.byteLength(child, "base64") } : redactMedia(child),
  ])) as T;
}
