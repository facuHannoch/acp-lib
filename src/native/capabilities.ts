import type { ConversationCapabilities } from "../conversation-controller/capabilities.ts";

export function nativeConversationCapabilities(reminders = true, routines = false): ConversationCapabilities {
  return {
    nativeSteering: true,
    reminders,
    ...(routines ? { routines } : {}),
    // The harness times out model calls, approvals and tools itself and reports the outcome.
    supervision: "backend",
    freshContext: false,
    backend: {
      loadSession: false, forkSession: false, listSessions: false,
      media: { image: false, audio: false, file: false },
      mcpServers: { stdio: false, http: false, sse: false },
    },
  };
}
