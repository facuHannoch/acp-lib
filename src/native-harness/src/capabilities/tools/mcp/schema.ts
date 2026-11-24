const types = new Set(["object", "array", "string", "boolean", "integer", "number", "null"]);

interface Schema {
  type: string;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: Schema;
  enum?: unknown[];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function matches(type: string, value: unknown): boolean {
  switch (type) {
    case "object": return record(value);
    case "array": return Array.isArray(value);
    case "integer": return Number.isInteger(value);
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "null": return value === null;
    default: return typeof value === type;
  }
}

export function acceptsMcpSchema(input: unknown): input is Schema {
  let nodes = 0;
  function visit(node: unknown, depth: number): boolean {
    if (++nodes > 128 || depth > 8 || !record(node) || typeof node.type !== "string" || !types.has(node.type)) return false;
    for (const [key, value] of Object.entries(node)) {
      switch (key) {
        case "type": break;
        case "description": case "title": if (typeof value !== "string") return false; break;
        case "properties":
          if (node.type !== "object" || !record(value) || !Object.values(value).every(child => visit(child, depth + 1))) return false;
          break;
        case "required":
          if (node.type !== "object" || !Array.isArray(value) || new Set(value).size !== value.length ||
            !value.every(name => typeof name === "string" && record(node.properties) && Object.hasOwn(node.properties, name))) return false;
          break;
        case "additionalProperties":
          if (node.type !== "object" || typeof value !== "boolean") return false;
          break;
        case "items":
          if (node.type !== "array" || !visit(value, depth + 1)) return false;
          break;
        case "enum":
          if (!Array.isArray(value) || !value.length || new Set(value).size !== value.length ||
            node.type === "object" || node.type === "array" || !value.every(member => matches(node.type as string, member))) return false;
          break;
        default: return false;
      }
    }
    return true;
  }
  return record(input) && input.type === "object" && visit(input, 1) &&
    Buffer.byteLength(JSON.stringify(input)) <= 8192;
}

export function matchesMcpArguments(schema: Schema, value: unknown): boolean {
  if (!matches(schema.type, value) || (schema.enum && !schema.enum.includes(value))) return false;
  if (schema.items && Array.isArray(value)) return value.every(item => matchesMcpArguments(schema.items!, item));
  if (!record(value)) return true;
  if (schema.required?.some(key => !Object.hasOwn(value, key))) return false;
  return Object.entries(value).every(([key, entry]) => {
    const properties = schema.properties;
    return properties && Object.hasOwn(properties, key)
      ? matchesMcpArguments(properties[key]!, entry)
      : schema.additionalProperties !== false;
  });
}

export function mcpToolName(server: string, remote: string): string | undefined {
  if (!/^[a-z][a-z0-9]{0,11}$/.test(server) || !remote || !remote.isWellFormed() || Buffer.byteLength(remote) > 22) return;
  return `mcp__${server}__${Buffer.from(remote).toString("hex")}`;
}
