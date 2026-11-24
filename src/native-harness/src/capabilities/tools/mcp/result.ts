/** SDK-validated result, projected without exposing unsupported block payloads. */
export function projectMcpResult(result: {
  content: readonly { type: string; text?: string }[];
  structuredContent?: unknown;
}): string {
  const textBlocks = result.content.filter(block => block.type === "text" && typeof block.text === "string");
  const output = {
    text: textBlocks.map(block => block.text).join("\n"),
    structuredContent: result.structuredContent ?? null,
    omittedContentBlocks: result.content.length - textBlocks.length,
    truncated: false,
  };
  const serialize = () => JSON.stringify(output);
  const fits = () => Buffer.byteLength(serialize()) <= 2048;
  if (fits()) return serialize();
  output.truncated = true;
  if (output.structuredContent !== null) output.structuredContent = null;
  if (fits()) return serialize();
  const units: string[] = [];
  for (const unit of output.text) {
    if (units.length === 2048) break;
    units.push(unit);
  }
  let low = 0, high = units.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    output.text = units.slice(0, mid).join("");
    if (fits()) low = mid;
    else high = mid - 1;
  }
  output.text = units.slice(0, low).join("");
  return serialize();
}
