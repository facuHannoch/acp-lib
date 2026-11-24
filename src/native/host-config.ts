import type { RoutineConfig } from "./reminders/routine-wire.ts";
import type { HarnessClient, ChannelEvent, ChannelChangeResult } from "../native-harness/src/client.ts";
import type { AcpLauncher } from "../launcher.ts";
import type { Logger } from "../logger.ts";
import type { NativeHostRecords } from "./records.ts";
import type { NativeFunctionsConfig } from "./functions.ts";
import type { ReminderNotification } from "./reminders/wire.ts";
import type { ReminderTimer } from "./reminders/supervisor.ts";

/** What a live connection to a harness is, for the host. Tests substitute it; production spawns a process. */
export interface NativeConnection {
  readonly client: HarnessClient;
  onReminderNotification?(listener: (event: ReminderNotification) => void): void;
  /** Settles when the connection is gone (process exit, pipe closed, protocol failure). */
  readonly closed: Promise<void>;
  /** Ends the process. Graceful first (closing its input is a stop for the harness), then forced. */
  kill(): Promise<void>;
}

export type NativeApprovalRequest = Omit<Extract<ChannelEvent["event"], { type: "approval_requested" }>, "type"> & { channel: string };
export type NativeApprovalResponder = (
  request: NativeApprovalRequest,
  answer: (decision: "allow_once" | "deny") => Promise<boolean>,
  signal: AbortSignal,
) => void | Promise<void>;

export interface NativeHarnessHostConfig {
  /** The durable harness session: the Agent's id. */
  readonly sessionId: string;
  /** Sent on every open. Session configuration is fixed while the session is open. */
  readonly config: RoutineConfig;
  /** The harness home, a path in the harness's environment. Must survive process restarts. */
  readonly home: string;
  /** How to start the harness server; defaults to this package's harness in `serve --stdio` mode. */
  readonly command?: readonly string[];
  readonly launcher?: AcpLauncher;
  readonly env?: Record<string, string>;
  readonly cwd?: string;
  readonly records?: NativeHostRecords;
  /** `final`: complete assistant messages only. `stream`: text deltas too. Default `final`. */
  readonly text?: "final" | "stream";
  /** From spawn to the open response. Default 30 000 ms. On expiry the process is killed and the start fails. */
  readonly startupTimeoutMs?: number;
  /** Per request to the running harness. Default 30 000 ms. */
  readonly requestTimeoutMs?: number;
  /** Automatic reopen attempts after an unexpected loss with work outstanding. Default 3 within 60 000 ms. */
  readonly reminderTimer?: ReminderTimer;
  readonly idleStopMs?: number;
  readonly idleStopWindowMs?: number;
  readonly restart?: { readonly limit: number; readonly windowMs: number };
  readonly logger?: Logger;
  /** A blocked channel change (a delete that found pending work, a resume the configuration cannot run...). */
  readonly onChannelChangeBlocked?: (result: ChannelChangeResult) => void;
  /** Functions the model can call, served by this process (tools and callbacks spec). */
  readonly functions?: NativeFunctionsConfig;
  readonly approvalResponder?: NativeApprovalResponder;
  /** Test seam: replaces the process launch. */
  readonly connect?: () => Promise<NativeConnection>;
}
