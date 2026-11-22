/** Version and human-readable label for the first JSONL record. */
export interface ScenarioHeader { type: "scenario"; version: 1; name: string }

/** A delay relative to the preceding chunk, or to the initial delay for the
 * first chunk. The final text must equal the concatenated chunks. */
export interface ScenarioChunk { afterMs: number; text: string }

export interface ScenarioCall { id: string; name: string; arguments: Record<string, unknown> }

/** One durable script position and one provider-neutral attempt. */
export type ScenarioModelRecord = {
  type: "model";
  channelId?: string;
  delayMs?: number;
  chunks?: ScenarioChunk[];
  usage?: import("./model-execution.ts").ModelUsage;
} & (
  | { content: string | null; calls?: ScenarioCall[]; failure?: never; wait?: never }
  | { content?: never; calls?: never; failure: {
      kind: Extract<import("./model-execution.ts").ModelAttemptEvent, { type: "failure" }>["kind"];
      message: string;
    }; wait?: never }
  | { content?: never; calls?: never; failure?: never; wait: "cancel" }
);

/** A scheduled send's stable identity and its offset on the monotonic run clock. */
export interface ScenarioSend {
  type: "send"; atMs: number; channelId: string; participantId: string; inputId: string; text: string;
}

export type ScenarioRecord = ScenarioHeader | ScenarioModelRecord | ScenarioSend;

/** Validated local script. Each open shares the same immutable sequences.
 * Position belongs to the requesting channel, even for a default sequence. */
export interface LoadedScenario {
  readonly name: string;
  readonly modelDigest: string;
  readonly fileDigest: string;
  readonly defaultModels: readonly ScenarioModelRecord[];
  readonly channelModels: ReadonlyMap<string, readonly ScenarioModelRecord[]>;
  readonly sends: readonly ScenarioSend[];
}
