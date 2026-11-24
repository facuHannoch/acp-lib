import type { ManagedConfig } from "../../../contracts/config-permissions.ts";
import { spawnMcpStdio } from "../../../runtime/execution/mcp-stdio.ts";
import type { McpServerStatus, McpTool } from "../../../contracts/mcp.ts";
import { connectMcpStdio } from "./client.ts";

export async function openMcpRegistry(config: ManagedConfig, environment: Record<string, string | undefined>) {
  const entries = Object.entries(config.mcpServers ?? {}).sort(([a], [b]) => a.localeCompare(b));
  type Connection = Awaited<ReturnType<typeof connectMcpStdio>>;
  const connections: Connection[] = [];
  const bindings = new Map<string, McpTool>();
  const status = Object.create(null) as Record<string, McpServerStatus>;
  let bytes = 0;
  for (let offset = 0; offset < entries.length; offset += 4) {
    const batch = await Promise.all(entries.slice(offset, offset + 4).map(async ([name, entry]) => {
      const transport = entry.transport;
      if (entry.enabled === false) { status[name] = { transport, state: "disabled" }; return; }
      if (transport !== "stdio") { status[name] = { transport, state: "unavailable", reason: "config" }; return; }
      const env: Record<string, string> = Object.create(null);
      for (const [key, value] of Object.entries(entry.env ?? {})) {
        const resolved = environment[value.env];
        if (!resolved?.trim() || resolved.includes("\0")) {
          status[name] = { transport, state: "unavailable", reason: "config" }; return;
        }
        env[key] = resolved;
      }
      let child;
      try { child = spawnMcpStdio({ ...entry, env }); }
      catch { status[name] = { transport, state: "unavailable", reason: "spawn" }; return; }
      try { return { name, connection: await connectMcpStdio(name, child, config.limits?.mcpCallTimeoutMs, Object.values(env)) }; }
      catch { status[name] = { transport, state: "unavailable", reason: "discovery" }; return; }
    }));
    for (const result of batch) {
      if (!result) continue;
      const { name, connection } = result;
      if (bytes + connection.bytes > 128 * 1024 || bindings.size + connection.bindings.size > 64) {
        status[name] = { transport: "stdio", state: "unavailable", reason: "limit" };
        await connection.close();
      } else {
        status[name] = { transport: "stdio", state: "ready" };
        bytes += connection.bytes;
        connections.push(connection);
        for (const [id, tool] of connection.bindings) bindings.set(id, tool);
      }
    }
  }
  let closing: Promise<void> | undefined;
  return { bindings, status() {
    return Object.fromEntries(Object.entries(status).map(([name, state]) => [name,
      state.state === "ready" && connections.some(connection => connection.name === name && !connection.available())
        ? { ...state, state: "unavailable" as const, reason: "closed" as const } : state]));
  }, close() { return closing ??= Promise.allSettled(connections.map(connection => connection.close())).then(() => {}); } };
}
