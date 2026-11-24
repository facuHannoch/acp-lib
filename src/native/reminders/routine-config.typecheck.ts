import type { AgentConfig } from "../../agent/config.ts";
import type { ProtocolConfig } from "../../native-harness/src/client.ts";

type Config = NonNullable<AgentConfig["harness"]>["config"];
type PublicLimit = NonNullable<Config["limits"]>["unattendedTurns"];
type WireLimit = NonNullable<ProtocolConfig["limits"]>["unattendedTurns"];

export const numericLimit = 3 satisfies PublicLimit;
export const unlimitedLimit = "unlimited" satisfies PublicLimit;
// @ts-expect-error The public sentinel is case-sensitive.
export const wrongSpelling = "Unlimited" satisfies PublicLimit;
// @ts-expect-error The public sentinel cannot be sent on the wire.
export const wireSentinel = "unlimited" satisfies WireLimit;
