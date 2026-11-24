import { expect, test } from "bun:test";
import { validateManagedConfig } from "../src/util/config.ts";
import { resolveWebCredentials } from "../src/util/web-config.ts";

const base = { version: 1, system: "test", model: { protocol: "scripted", script: "fixture" }, defaultPolicy: "allow", policies: { allow: { fallback: "allow", tools: {} } } };

test("managed config preserves independent web backend choices and references", () => {
  const value = validateManagedConfig({ ...base, webSearch: { backend: "exa", apiKeyEnv: "SEARCH_KEY", maxResults: 3 }, webFetch: { backend: "http", deadlineMs: 2000 } });
  expect(value.webSearch).toEqual({ backend: "exa", apiKeyEnv: "SEARCH_KEY", maxResults: 3 });
  expect(value.webFetch).toEqual({ backend: "http", deadlineMs: 2000 });
  expect(resolveWebCredentials(value, { SEARCH_KEY: "secret" })).toEqual({ ok: true, value: { searchKey: "secret" } });
  expect(JSON.stringify(value)).not.toContain("secret");
  expect(() => validateManagedConfig({ ...base, webSearch: { backend: "http" } })).toThrow();
  expect(() => validateManagedConfig({ ...base, webFetch: { backend: "http", apiKeyEnv: "TOKEN" } })).toThrow();
  expect(() => validateManagedConfig({ ...base, webSearch: { backend: "exa", deadlineMs: 0 } })).toThrow();
  expect(validateManagedConfig({ ...base, webFetch: { backend: "exa" } }).webFetch).toEqual({ backend: "exa" });
});
