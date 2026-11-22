import { describe, expect, test } from "bun:test";
import { toPermissionRequest } from "../src/permissions/acp.ts";
import { matchPermissionLevel, type PermissionSettings } from "../src/permissions/matcher.ts";
import { selectPermissionOutcome } from "../src/permissions/outcome.ts";
import type { PermissionOption } from "../src/permissions/request.ts";
import { claudeExecute, claudeWithoutKind, codexExecute, grokExecute, openCodeExecute } from "./fixtures/permission-requests.ts";

const allowBun: PermissionSettings = { default: "ask", rules: { "command:bun test": "allow" } };
const execute = (rawInput: unknown) => ({ tool: { kind: "execute", rawInput } });

describe("ACP permission rules", () => {
  for (const [adapter, packet] of [
    ["Codex (capture-backed)", codexExecute],
    ["Claude (capture-backed)", claudeExecute],
    ["OpenCode (source-derived)", openCodeExecute],
  ] as const) {
    test(`${adapter} matches the complete command`, () => {
      expect(matchPermissionLevel(toPermissionRequest(packet), allowBun)).toBe("allow");
    });
  }

  test("Grok (source-derived) matches the raw command including its leading cd", () => {
    const request = toPermissionRequest(grokExecute);
    expect(matchPermissionLevel(request, allowBun)).toBe("ask");
    expect(matchPermissionLevel(request, {
      default: "ask", rules: { "command:cd /workspace && bun test": "allow" },
    })).toBe("allow");
  });

  test("uses the most restrictive matching rule regardless of insertion order", () => {
    const request = toPermissionRequest(codexExecute);
    expect(matchPermissionLevel(request, {
      default: "allow", rules: { "kind:execute": "ask", "command:bun test": "deny" },
    })).toBe("deny");
    expect(matchPermissionLevel(request, {
      default: "deny", rules: { "command:bun test": "allow", "kind:execute": "ask" },
    })).toBe("ask");
    expect(matchPermissionLevel(request, { default: "deny", rules: allowBun.rules })).toBe("allow");
  });

  test("uses explicit kinds and ignores titles, tool names, and a command without execute kind", () => {
    expect(matchPermissionLevel({ tool: { kind: "read", rawInput: { command: "bun test" } } }, {
      default: "deny", rules: { "kind:read": "allow", "command:bun test": "deny" },
    })).toBe("allow");
    expect(matchPermissionLevel(toPermissionRequest(claudeWithoutKind), allowBun)).toBe("ask");
    const titleOnly = { title: "bun test", tool: { name: "bun test", kind: "execute" } };
    expect(matchPermissionLevel(titleOnly, allowBun)).toBe("ask");
    expect(matchPermissionLevel({}, { default: "deny" })).toBe("deny");
  });

  test("matches exactly the supported bash -lc wrappers and unambiguous argument lists", () => {
    for (const input of [
      { command: 'bash -lc "bun test"' }, { command: "bash -lc 'bun test'" },
      ["bash", "-lc", "bun test"], { command: "bash", args: ["-lc", "bun test"] },
      ["bun", "test"], { argv: ["bun", "test"] }, { command: ["bun", "test"] }, { command: "bun", args: ["test"] },
      "bun test",
    ]) {
      expect(matchPermissionLevel(execute(input), allowBun)).toBe("allow");
    }
  });

  test("rejects ambiguous inputs and never grants for a prefix or substring", () => {
    for (const input of [
      undefined, {}, { description: "bun test" }, { command: 1 }, { argv: [] },
      { command: "bun test", argv: ["bun", "test"] }, ["bun test"], ["bun", "test", ""], ["bun", "te st"],
      ["bun", "test", null], ["bash", "-lc", "bun test", "extra"],
      "bun testing", "bun test --watch", "env bun test", "bun test && echo done", "bun  test",
      'bash -lc "bun test" && echo extra', 'bash -lc "bun test $OPT"', "bash -lc 'bun test",
      "/bin/bash -lc 'bun test'", "bash -c 'bun test'", "sh -lc 'bun test'", "bun test\n",
    ]) {
      expect(matchPermissionLevel(execute(input), allowBun)).toBe("ask");
    }
    expect(matchPermissionLevel(execute({}), { default: "ask", rules: { "kind:execute": "deny" } })).toBe("deny");
    expect(matchPermissionLevel(execute({}), {
      default: "ask", rules: { "command:undefined": "allow", "command:": "allow" },
    })).toBe("ask");
  });
});

describe("automatic option selection", () => {
  const options: PermissionOption[] = [
    { optionId: "permanent-reject", name: "Always reject", kind: "reject_always" },
    { optionId: "standing", name: "Always allow", kind: "allow_always" },
    { optionId: "approval", name: "Allow", kind: "allow_once" },
    { optionId: "refusal", name: "Reject", kind: "reject_once" },
  ];

  test("prefers allow_once and falls back to allow_always", () => {
    expect(selectPermissionOutcome("allow", options)).toEqual({ outcome: "selected", optionId: "approval" });
    expect(selectPermissionOutcome("allow", options.slice(0, 2))).toEqual({ outcome: "selected", optionId: "standing" });
    expect(selectPermissionOutcome("allow", options.slice(0, 1))).toEqual({ outcome: "cancelled" });
  });

  test("denies with reject_once, falls back to cancellation, and leaves ask to the caller", () => {
    expect(selectPermissionOutcome("deny", options)).toEqual({ outcome: "selected", optionId: "refusal" });
    expect(selectPermissionOutcome("deny", options.slice(0, 3))).toEqual({ outcome: "cancelled" });
    expect(selectPermissionOutcome("ask", options)).toBeUndefined();
  });
});
