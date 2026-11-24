export function protocolMethod(message: unknown): string | undefined {
  if (message === null || Array.isArray(message) || typeof message !== "object") return undefined;
  const method = (message as { readonly method?: unknown }).method;
  return typeof method === "string" ? method : undefined;
}
