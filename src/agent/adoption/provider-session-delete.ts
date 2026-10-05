import { AcpClient } from "../../client.ts";
import type { ProviderSessionListing } from "./provider-sessions.ts";

/**
 * Ask the provider to delete one of its sessions (`session/delete`). Best effort: not every agent offers it, and
 * a failure leaves the session where it was. Starts the harness for the call and stops it again.
 *
 * - `true`: the provider deleted it.
 * - `"unsupported"`: the agent does not advertise `session/delete`.
 * - `false`: it could not be done (the harness did not start, or refused).
 */
export async function deleteProviderSession(
  access: Omit<ProviderSessionListing, "owners">,
  providerSessionId: string,
): Promise<true | false | "unsupported"> {
  const client = new AcpClient({ adapter: access.adapter, ...access.client, defaultPermission: "cancel" });
  try {
    await client.connect();
    if (!client.capabilities.agent.sessionCapabilities.delete) return "unsupported";
    await client.deleteSession(providerSessionId);
    return true;
  } catch {
    return false;
  } finally {
    await client.stop().catch(() => undefined);
  }
}
