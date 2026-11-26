/** Process-local status of the optional managed inspector. */
export type InspectorStatus =
  | { state: "listening"; host: "127.0.0.1" | "0.0.0.0"; port: number }
  | { state: "unavailable"; code: "invalid_config" | "bind_failed" }
  | { state: "stopped" };
