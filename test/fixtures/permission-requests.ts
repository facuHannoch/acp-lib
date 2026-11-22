import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";

function permission(toolCall: RequestPermissionRequest["toolCall"]): RequestPermissionRequest {
  return {
    sessionId: "fixture-session",
    toolCall,
    options: [
      { optionId: "deny", name: "Deny", kind: "reject_once" },
      { optionId: "once", name: "Allow once", kind: "allow_once" },
    ],
  };
}

// Capture-backed. test2/chats/_/codex-http-1785431940097.wire.jsonl.
export const codexExecute = permission({
  toolCallId: "codex-call", kind: "execute", status: "pending",
  rawInput: { command: "bun test", cwd: "/workspace" },
});

// Capture-backed. test4-permission/chats/claude-permission-shell-1785849706978.wire.jsonl.
export const claudeExecute = permission({
  toolCallId: "claude-call", kind: "execute", title: "Bash",
  rawInput: { command: "bun test", description: "Run the tests" },
});

// Capture-backed. test4-permission/chats/claude-permission-shell-1785847657720.wire.jsonl.
export const claudeWithoutKind = permission({
  toolCallId: "older-claude-call", title: "Bash",
  rawInput: { command: "bun test", description: "Run the tests", timeout: 10_000 },
});

// Source-derived from OpenCode v1.18.34 ACP permission.ts and tool.ts.
export const openCodeExecute = permission({
  toolCallId: "opencode-call", kind: "execute", title: "Run the tests",
  rawInput: { command: "bun test", cwd: "/workspace" },
});

// Source-derived from Grok 37949780c144e37df692e3d669051a21fec24f20 tool_calls.rs.
// The tool label can omit a leading cd while the raw command retains it.
export const grokExecute = permission({
  toolCallId: "grok-call", kind: "execute", title: "Execute `bun test`",
  rawInput: { command: "cd /workspace && bun test", description: "Run the tests" },
});
