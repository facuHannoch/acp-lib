// End-to-end permission handling against a real agent process.
//
// Everything here asserts on the outcome the AGENT received, not on library internals:
// the bug being pinned was a wrong `optionId` going out over the wire, and only the far
// end of the connection can prove which one that was. The fixture echoes the outcome
// back as its message text.

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { AcpClient } from "../src/client.ts";
import type { AcpClientConfig } from "../src/client.ts";
import type { PermissionRequest, PromptHandlers } from "../src/types.ts";
import { toPermissionRequest } from "../src/permissions/acp.ts";

const AGENT = resolve(import.meta.dir, "fixtures/permission-agent.ts");

/** Run one turn against the named option set; return the outcome the agent was sent. */
async function ask(
  optionSet: string,
  config: Partial<AcpClientConfig> = {},
  handlers: PromptHandlers = {},
): Promise<{ outcome: string; optionId?: string }> {
  const client = new AcpClient({
    adapter: { command: ["bun", AGENT] },
    cwd: import.meta.dir,
    ...config,
  });
  await client.connect();
  await client.startSession();
  try {
    const result = await client.prompt(optionSet, handlers);
    return JSON.parse(result.text);
  } finally {
    await client.stop();
  }
}

describe("permission requests", () => {
  test("projects ACP tool data and keeps the original wire request", () => {
    const params = {
      sessionId: "s1",
      toolCall: { toolCallId: "t1", title: "Run tests", kind: "execute" as const, rawInput: { command: "bun test" } },
      options: [{ optionId: "once", name: "Allow once", kind: "allow_once" as const }],
    };
    const request = toPermissionRequest(params);
    expect(request.tool).toEqual({ kind: "execute", rawInput: { command: "bun test" } });
    expect(request.options).toEqual(params.options);
    expect(request.raw).toBe(params);
  });

  describe("default allow", () => {
    const approve = { permissions: { default: "allow" as const } };

    // THE REGRESSION. Claude leads with its reject option, so a client that took
    // `options[0]` auto-refused every call it meant to auto-approve — which made MCP
    // servers unusable while reporting the agent's own refusal as the cause.
    test("selects the allow option even when the agent lists reject first", async () => {
      const outcome = await ask("reject-first", approve);
      expect(outcome).toEqual({ outcome: "selected", optionId: "allow" });
    });

    test("selects the allow option when the agent lists it first", async () => {
      const outcome = await ask("allow-first", approve);
      expect(outcome).toEqual({ outcome: "selected", optionId: "allow" });
    });

    // `allow_always` writes a rule into the agent's own settings that outlives this
    // session. Auto-approving a single call must never quietly become policy, so it is
    // the fallback and never the preference — "reject-first" offers both and gets
    // `allow`, above.
    test("takes allow_always only when allow_once is not offered", async () => {
      const outcome = await ask("always-only", approve);
      expect(outcome).toEqual({ outcome: "selected", optionId: "always" });
    });

    // Guessing is what caused the bug. With nothing recognizable to approve, refusing is
    // the only safe direction: selecting `options[0]` here would pick "No" anyway, and
    // selecting anything else would grant permission the caller never asked us to grant.
    test("cancels rather than guessing when no allow option is offered", async () => {
      const outcome = await ask("reject-only", approve);
      expect(outcome).toEqual({ outcome: "cancelled" });
      expect(outcome.optionId).toBeUndefined();
    });

    test("cancels when the agent offers no options at all", async () => {
      const outcome = await ask("empty", approve);
      expect(outcome).toEqual({ outcome: "cancelled" });
    });
  });

  describe("refusal", () => {
    test("deny selects reject_once and cancels when it is unavailable", async () => {
      expect(await ask("reject-first", { permissions: { default: "deny" } })).toEqual({
        outcome: "selected", optionId: "reject",
      });
      expect(await ask("empty", { permissions: { default: "deny" } })).toEqual({
        outcome: "cancelled",
      });
    });

    test("omitted settings ask and refuse immediately without a handler", async () => {
      expect(await ask("reject-first")).toEqual({ outcome: "selected", optionId: "reject" });
      expect(await ask("empty")).toEqual({ outcome: "cancelled" });
    });
  });

  describe("onPermissionRequest handler", () => {
    test("allow and deny bypass the prompt handler", async () => {
      const handler = { onPermissionRequest() { throw new Error("must not run"); } };
      expect(await ask("reject-first", { permissions: { default: "allow" } }, handler))
        .toEqual({ outcome: "selected", optionId: "allow" });
      expect(await ask("reject-first", { permissions: { default: "deny" } }, handler))
        .toEqual({ outcome: "selected", optionId: "reject" });
    });

    test("permissionRule can choose ask before matching rules and the default", async () => {
      const outcome = await ask("execute", {
        permissions: { default: "deny", rules: { "kind:execute": "deny", "command:bun test": "deny" } },
        permissionRule: (request) => {
          expect(request.tool).toEqual({ kind: "execute", rawInput: { command: "bun test" } });
          return "ask";
        },
      }, {
        onPermissionRequest: () => ({ outcome: "selected", optionId: "allow" }),
      });
      expect(outcome).toEqual({ outcome: "selected", optionId: "allow" });
    });

    test("may cancel an ask", async () => {
      const outcome = await ask("allow-first", {}, {
        onPermissionRequest: () => ({ outcome: "cancelled" }),
      });
      expect(outcome).toEqual({ outcome: "cancelled" });
    });

    // The handler is the whole point of the human-in-the-loop path: it has to receive
    // enough to render a choice, `kind` included, since that is what tells a UI which
    // button is destructive.
    test("receives the options with their kinds, and the call being asked about", async () => {
      let seen: PermissionRequest | null = null;
      await ask("reject-first", {}, {
        onPermissionRequest: (request) => {
          seen = request;
          return { outcome: "cancelled" };
        },
      });

      const request = seen as PermissionRequest | null;
      expect(request).not.toBeNull();
      expect(request!.toolCallId).toBe("call-1");
      expect(request!.title).toBe("Write config.json");
      expect(request).not.toHaveProperty("tool");
      expect(request!.options).toEqual([
        { optionId: "reject", name: "No", kind: "reject_once" },
        { optionId: "allow", name: "Yes", kind: "allow_once" },
        { optionId: "always", name: "Yes, and don't ask again", kind: "allow_always" },
      ]);
    });

    // The agent blocks on this request, so the answer arriving later is the normal case,
    // not an edge one — a human clicking a button is always later.
    test("may answer asynchronously", async () => {
      const outcome = await ask("reject-first", {}, {
        onPermissionRequest: async () => {
          await new Promise((r) => setTimeout(r, 20));
          return { outcome: "selected", optionId: "always" };
        },
      });
      expect(outcome).toEqual({ outcome: "selected", optionId: "always" });
    });
  });

  test("validates rule keys and levels when constructing the client", () => {
    const adapter = { command: ["bun", AGENT] };
    for (const key of ["kind:exectue", "command:", "worker:kind:read"]) {
      expect(() => new AcpClient({ adapter, permissions: { default: "ask", rules: { [key]: "allow" } } }))
        .toThrow("invalid permission rule key");
    }
    expect(() => new AcpClient({
      adapter, permissions: { default: "ask", rules: { "kind:read": "alow" as never } },
    })).toThrow("invalid permission level");
  });
});

test("an unanswered ACP ask selects reject_once by default or sends a cancelled reply", async () => {
  expect(await ask("reject-first", { permissions: { default: "ask", unanswered: "reject" } }))
    .toEqual({ outcome: "selected", optionId: "reject" });
  expect(await ask("reject-first", { permissions: { default: "ask", unanswered: "cancel" } }))
    .toEqual({ outcome: "cancelled" });
  expect(await ask("reject-first", { permissions: { default: "deny", unanswered: "cancel" } }))
    .toEqual({ outcome: "selected", optionId: "reject" });
});
