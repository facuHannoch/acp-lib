import type { Adapter } from "../../adapters.ts";
import type { AgentConversationId } from "../../agent-ids.ts";
import { ProviderSessionListUnsupportedError } from "../../agent-conversation-errors.ts";
import { AcpClient, type AcpClientConfig } from "../../client.ts";

/** A session the provider holds, as `session/list` reports it, and the conversation that owns it, if any. */
export interface ProviderSessionSummary {
  readonly providerSessionId: string;
  readonly cwd: string;
  readonly title?: string;
  readonly updatedAt?: string;
  /** The conversation that already owns this session (or asked to adopt it), so a UI can open it instead. */
  readonly adoptedBy?: AgentConversationId;
}

export interface ListProviderSessionsOptions {
  /** Which adapter to ask. Defaults to the Agent's default adapter. */
  readonly adapterId?: string;
  /** Only sessions of this working directory. Defaults to the conversations' default `cwd`, if any. */
  readonly cwd?: string;
  /** Stop after this many sessions (default 100). */
  readonly limit?: number;
}

export const DEFAULT_PROVIDER_SESSION_LIMIT = 100;

/** What a listing needs from the Agent: how to start the harness, and who owns a session. */
export interface ProviderSessionListing {
  readonly adapterId: string;
  readonly adapter: Adapter;
  readonly client: Pick<AcpClientConfig, "launcher" | "execPrefix" | "env" | "cwd" | "clientInfo" | "logger">;
  owners(providerSessionId: string): Promise<readonly AgentConversationId[]>;
}

/**
 * Ask the provider which sessions it holds. This starts the harness for the duration of the call (a listing
 * has no conversation to ride on) and stops it again. Sessions are listed as the provider orders them.
 */
export async function listProviderSessions(
  listing: ProviderSessionListing,
  options: ListProviderSessionsOptions = {},
): Promise<readonly ProviderSessionSummary[]> {
  const limit = options.limit ?? DEFAULT_PROVIDER_SESSION_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");
  const cwd = options.cwd ?? listing.client.cwd;
  const client = new AcpClient({ adapter: listing.adapter, ...listing.client, ...(cwd ? { cwd } : {}), defaultPermission: "cancel" });
  const sessions: ProviderSessionSummary[] = [];
  try {
    await client.connect();
    if (!client.capabilities.agent.sessionCapabilities.list) {
      throw new ProviderSessionListUnsupportedError(listing.adapterId);
    }
    let cursor: string | undefined;
    do {
      const page = await client.listSessions({ ...(cwd ? { cwd } : {}), ...(cursor ? { cursor } : {}) });
      for (const entry of page.sessions) {
        const owner = (await listing.owners(entry.sessionId))[0];
        sessions.push(Object.freeze({
          providerSessionId: entry.sessionId,
          cwd: entry.cwd,
          ...(entry.title ? { title: entry.title } : {}),
          ...(entry.updatedAt ? { updatedAt: entry.updatedAt } : {}),
          ...(owner ? { adoptedBy: owner } : {}),
        }));
        if (sessions.length >= limit) return Object.freeze(sessions);
      }
      cursor = page.nextCursor;
    } while (cursor);
    return Object.freeze(sessions);
  } finally {
    await client.stop().catch(() => undefined);
  }
}
