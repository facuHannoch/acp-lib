/**
 * Neutral capabilities of a conversation's backend (controller-interface spec, Capabilities).
 *
 * Two kinds of support are kept apart: what the *controller type* supports is the presence of its
 * optional methods (the compiler forces the check), and what the *backend offers* is data, which can
 * change and may be unknown: `ConversationCapabilities`. The raw ACP `Capabilities` stays on the
 * `HarnessController`, the session and the conversation with its shape unchanged.
 */
import type { Capabilities } from "../capabilities.ts";
import { NotConnectedError } from "../errors.ts";
import type { MediaCapabilities } from "../media/acp.ts";

export interface ConversationCapabilities {
  /** Steer by injecting into the running turn; false for the `HarnessController`. */
  nativeSteering: boolean;
  /** Null when unknown: before the agent's `initialize`, and in PTY mode. */
  backend: BackendCapabilities | null;
  /**
   * `false`: the backend cannot start a fresh context, so `startFresh` (and whatever needs it: a context
   * reset, recovery onto a new provider session) is unsupported and throws `UnsupportedError` before
   * changing anything. Absent: it can. A native conversation shares its agent's session and timeline,
   * and has no context reset.
   */
  freshContext?: false;
}

export interface BackendCapabilities {
  /** Can reattach to a provider session with its context. */
  loadSession: boolean;
  forkSession: boolean;
  listSessions: boolean;
  media: { image: boolean; audio: boolean; file: boolean };
  mcpServers: { stdio: boolean; http: boolean; sse: boolean };
  /** The raw ACP `initialize` result. */
  acp?: Capabilities;
}

/**
 * The backend capabilities of an ACP agent, from its `initialize` result. `file` is the agent's
 * `embeddedContext` (how ACP carries a file's content); every ACP agent accepts stdio MCP servers.
 */
export function fromAcp(capabilities: Capabilities): BackendCapabilities {
  const agent = capabilities.agent;
  return {
    loadSession: agent.loadSession,
    forkSession: agent.sessionCapabilities.fork,
    listSessions: agent.sessionCapabilities.list,
    media: {
      image: agent.promptCapabilities.image,
      audio: agent.promptCapabilities.audio,
      file: agent.promptCapabilities.embeddedContext,
    },
    mcpServers: { stdio: true, http: agent.mcpCapabilities.http, sse: agent.mcpCapabilities.sse },
    acp: capabilities,
  };
}

/** What an ACP controller reports: no native steering; `backend` unknown until the agent has answered. */
export function conversationCapabilitiesFromAcp(capabilities: Capabilities | null): ConversationCapabilities {
  return { nativeSteering: false, backend: capabilities ? fromAcp(capabilities) : null };
}

/** The same, read from an ACP client that may be absent (PTY mode) or not connected yet. */
export function conversationCapabilitiesOf(client: { readonly capabilities: Capabilities } | null | undefined): ConversationCapabilities {
  let capabilities: Capabilities | null = null;
  if (client) {
    try {
      capabilities = client.capabilities;
    } catch (error) {
      if (!(error instanceof NotConnectedError)) throw error;
    }
  }
  return conversationCapabilitiesFromAcp(capabilities);
}

/** The media a backend accepts, in the shape the prompt builder reads (`file` is ACP's `embeddedContext`); none when unknown. */
export function mediaCapabilitiesOf(backend: BackendCapabilities | null): MediaCapabilities | undefined {
  return backend ? { image: backend.media.image, audio: backend.media.audio, embeddedContext: backend.media.file } : undefined;
}
