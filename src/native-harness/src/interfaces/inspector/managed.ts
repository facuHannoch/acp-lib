import type { PersistentSession } from "../../contracts/session.ts";
import type { InspectorStatus } from "../../contracts/inspector.ts";
import type { InspectorBinding } from "./config.ts";
import type { Inspection } from "./state.ts";
import { observeSession } from "./observe.ts";
import { serveInspector } from "./server.ts";

export function managedInspector(binding: InspectorBinding | "invalid", inspection?: Inspection,
  project?: (body: unknown) => unknown) {
  let status: InspectorStatus = { state: "unavailable", code: "invalid_config" };
  let listener: ReturnType<typeof serveInspector> | undefined;
  let detach: (() => void) | undefined;
  let stopping: Promise<void> | undefined;

  return {
    active: () => status.state === "listening",
    status: () => status,
    start(session: PersistentSession) {
      if (binding === "invalid" || !inspection || status.state === "listening" || stopping) return;
      try {
        listener = serveInspector(inspection, binding, project);
        detach = observeSession(session, inspection).stop;
        status = { state: "listening", host: binding.host, port: listener.port! };
      } catch {
        void listener?.stop(true);
        status = { state: "unavailable", code: "bind_failed" };
      }
    },
    stop() {
      if (stopping) return stopping;
      status = { state: "stopped" };
      detach?.();
      return stopping = Promise.resolve(listener?.stop(true));
    },
  };
}

/** Retain the development payload shape while hiding known runtime material. */
export function inspectorProjection(values: readonly (string | undefined)[]) {
  const secrets = [...new Set(values.filter((value): value is string => !!value))].sort((a, b) => b.length - a.length);
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sensitive = new RegExp([...secrets.map(escape), "data:image/[^;,]+;base64,[A-Za-z0-9+/=]+"].join("|"), "g");
  function project(value: unknown): unknown {
    if (typeof value === "string") return value.replace(sensitive, match => /^data:image\//i.test(match) ? "[REDACTED_IMAGE]" : "[REDACTED]");
    if (Array.isArray(value)) return value.map(project);
    if (value !== null && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [project(key), project(child)]));
    return value;
  }
  return project;
}
