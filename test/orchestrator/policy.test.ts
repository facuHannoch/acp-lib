import { expect, test } from "bun:test";
import { composeDelegationPolicy, matchWorkerPermissionLevel } from "../../src/orchestrator/policy.ts";

test("delegation composition intersects authority and uses the smallest cap", () => {
  expect(composeDelegationPolicy([
    { use: true, scope: "all", redirect: true, maxOpen: 5 },
    { use: false, scope: "none", redirect: true },
    { use: true, scope: "all", redirect: false, maxOpen: 2 },
  ])).toEqual({ use: false, scope: "none", redirect: false, maxOpen: 2 });
  expect(composeDelegationPolicy([{ use: true, scope: "all", redirect: true }]))
    .toEqual({ use: true, scope: "all", redirect: true });
});

test("worker permissions reduce matched levels with each policy's own default", () => {
  const request = { tool: { kind: "execute", rawInput: { command: "bun test" } } };
  expect(matchWorkerPermissionLevel(request, [
    { default: "deny", rules: { "kind:execute": "allow" } },
    { default: "deny", rules: { "command:bun test": "allow" } },
  ])).toBe("allow");
  expect(matchWorkerPermissionLevel(request, [
    { default: "allow", rules: { "command:bun test": "allow" } },
    { default: "ask" },
  ])).toBe("ask");
  expect(matchWorkerPermissionLevel(request, [{ default: "ask" }, { default: "deny" }])).toBe("deny");
});
