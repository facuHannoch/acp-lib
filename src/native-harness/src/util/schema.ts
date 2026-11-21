/** A small JSON Schema check for tool arguments (decision 0021). It covers what
 * a function's `parameters` normally use: `type`, `properties`, `required`,
 * `additionalProperties`, `enum`, `const`, `items`, and numeric and length
 * bounds. Keywords it does not know are ignored, so a schema is never stricter
 * here than its author wrote. Returns the first problem, or undefined. */
export function schemaProblem(schema: unknown, value: unknown, path = "arguments"): string | undefined {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return undefined;
  const rule = schema as Record<string, unknown>;
  const kind = (item: unknown) => item === null ? "null" : Array.isArray(item) ? "array" : Number.isInteger(item) ? "integer" : typeof item;
  if (rule.type !== undefined) {
    const allowed = Array.isArray(rule.type) ? rule.type : [rule.type], actual = kind(value);
    if (!allowed.some(type => type === actual || (type === "number" && actual === "integer"))) return `${path} must be ${allowed.join(" or ")}`;
  }
  if (Array.isArray(rule.enum) && !rule.enum.some(option => JSON.stringify(option) === JSON.stringify(value))) return `${path} must be one of ${JSON.stringify(rule.enum)}`;
  if ("const" in rule && JSON.stringify(rule.const) !== JSON.stringify(value)) return `${path} must be ${JSON.stringify(rule.const)}`;
  if (typeof value === "number") {
    if (typeof rule.minimum === "number" && value < rule.minimum) return `${path} must be at least ${rule.minimum}`;
    if (typeof rule.maximum === "number" && value > rule.maximum) return `${path} must be at most ${rule.maximum}`;
  }
  if (typeof value === "string") {
    if (typeof rule.minLength === "number" && value.length < rule.minLength) return `${path} must have at least ${rule.minLength} characters`;
    if (typeof rule.maxLength === "number" && value.length > rule.maxLength) return `${path} must have at most ${rule.maxLength} characters`;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const problem = schemaProblem(rule.items, value[index], `${path}[${index}]`);
      if (problem) return problem;
    }
  } else if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    const properties = rule.properties && typeof rule.properties === "object" ? rule.properties as Record<string, unknown> : {};
    for (const name of Array.isArray(rule.required) ? rule.required : []) if (!Object.hasOwn(object, name)) return `${path}.${name} is required`;
    for (const [name, item] of Object.entries(object)) {
      if (Object.hasOwn(properties, name)) { const problem = schemaProblem(properties[name], item, `${path}.${name}`); if (problem) return problem; }
      else if (rule.additionalProperties === false) return `${path}.${name} is not an accepted field`;
      else { const problem = schemaProblem(rule.additionalProperties, item, `${path}.${name}`); if (problem) return problem; }
    }
  }
  return undefined;
}
