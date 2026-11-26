import type { InspectorStatus } from "../../contracts/inspector.ts";

export type InspectorBinding = Pick<Extract<InspectorStatus, { state: "listening" }>, "host" | "port"> & {
  authority?: string;
};

export function managedInspectorBinding(env: Readonly<Record<string, string | undefined>>): InspectorBinding | "invalid" | undefined {
  const raw = env.HARNESS_INSPECTOR_PORT;
  if (raw === undefined) return undefined;
  const host = env.HARNESS_INSPECTOR_HOST ?? "127.0.0.1";
  const port = Number(raw);
  if (!/^\d{1,5}$/.test(raw) || port > 65535 || (host !== "127.0.0.1" && host !== "0.0.0.0")) return "invalid";
  const authority = env.HARNESS_INSPECTOR_PUBLIC_AUTHORITY;
  if (host === "127.0.0.1") return authority === undefined ? { host, port } : "invalid";
  const match = authority?.match(/^127\.0\.0\.1:([1-9]\d{0,4})$/);
  return match && Number(match[1]) <= 65535 ? { host, port, authority } : "invalid";
}
