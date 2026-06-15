// Capabilities mirror the protocol's nested structure directly (see SPEC.md
// "Capabilities"). We do NOT flatten — the nesting maps cleanly to what UIs gate on,
// e.g. `capabilities.agent.auth.logout != null` → show the logout button.
//
// A null/omitted capability means UNSUPPORTED (per spec: omitted == unsupported). This
// is what lets callers gate behavior in advance instead of failing at call time.

import type * as schema from "@agentclientprotocol/sdk";

export interface Capabilities {
  /** Protocol version the agent agreed on. */
  protocolVersion: number;
  /** Agent name/title/version, if provided. */
  agentInfo?: { name?: string; title?: string; version?: string };
  /** What WE told the agent we support (echoed back for convenience). */
  client: ClientCapabilities;
  /** What the AGENT reports it supports — discovered from initialize. */
  agent: AgentCapabilities;
  /** Auth methods the agent advertises (raw from initialize). */
  authMethods: schema.AuthMethod[];
}

export interface ClientCapabilities {
  fs: { readTextFile: boolean; writeTextFile: boolean };
  terminal: boolean;
}

export interface AgentCapabilities {
  loadSession: boolean;
  promptCapabilities: {
    image: boolean;
    audio: boolean;
    embeddedContext: boolean;
  };
  mcpCapabilities: {
    http: boolean;
    sse: boolean;
  };
  /** Null when the agent does not advertise logout. */
  auth: { logout: boolean } | null;
  /** Optional session-lifecycle methods, each true only if the agent advertises it. */
  sessionCapabilities: {
    list: boolean;
    delete: boolean;
    close: boolean;
    fork: boolean;
    resume: boolean;
    additionalDirectories: boolean;
  };
}

/** The client capabilities we always advertise. Kept in one place. */
export const CLIENT_CAPABILITIES: ClientCapabilities = {
  fs: { readTextFile: true, writeTextFile: true },
  terminal: true,
};

/** Parse a raw InitializeResponse into our nested Capabilities model. */
export function parseCapabilities(init: schema.InitializeResponse): Capabilities {
  const a = (init.agentCapabilities ?? {}) as Record<string, any>;
  const prompt = a.promptCapabilities ?? {};
  const mcp = a.mcpCapabilities ?? {};
  const session = a.sessionCapabilities ?? {};
  const agentInfo = (init as any).agentInfo as Capabilities["agentInfo"] | undefined;

  return {
    protocolVersion: init.protocolVersion,
    agentInfo,
    client: CLIENT_CAPABILITIES,
    agent: {
      loadSession: a.loadSession === true,
      promptCapabilities: {
        image: prompt.image === true,
        audio: prompt.audio === true,
        embeddedContext: prompt.embeddedContext === true,
      },
      mcpCapabilities: {
        http: mcp.http === true,
        sse: mcp.sse === true,
      },
      auth: a.auth != null ? { logout: a.auth.logout != null } : null,
      sessionCapabilities: {
        list: session.list != null,
        delete: session.delete != null,
        close: session.close != null,
        fork: session.fork != null,
        resume: session.resume != null,
        additionalDirectories: session.additionalDirectories != null,
      },
    },
    authMethods: (init as any).authMethods ?? [],
  };
}
