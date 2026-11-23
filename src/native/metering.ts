import type { NativeHarnessHost } from "./host.ts";
import type { NativeTurnMetering } from "../metering/native/source.ts";

/** The operator read proves closure without reopening a stopped harness. */
export function terminalNativeTurns(host: Pick<NativeHarnessHost, "channel" | "reconcileChannel">, channel: string): NonNullable<NativeTurnMetering["terminalEarlierTurns"]> {
  return async turnIds => {
    if (host.channel(channel)?.lifecycle === "retired") return new Set(turnIds);
    const { turns } = await host.reconcileChannel({ channel, turnIds: [...turnIds] });
    return new Set(turns.filter(turn => turn.channel === channel &&
      (turn.state === "completed" || turn.state === "interrupted" || turn.state === "failed")).map(turn => turn.turnId));
  };
}
