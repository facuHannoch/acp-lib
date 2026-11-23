import type { ContextTurnOutcome } from "./context.ts";
import type { ModelCallSummary } from "./model-execution.ts";
import type { StorageResult, StoredSession, TimelineEntry } from "./storage.ts";

export interface InspectionChannelStatus {
  id: string;
  pending: number;
  lifecycle: import("./storage.ts").ChannelLifecycle;
  turn?: "running" | "suspended";
  unresolved?: { turnId: number; status: "failed" | "interrupted"; reason: string; uncertainCallIds: string[] };
}

export type InspectionEntry = TimelineEntry | { seq: number; omitted: true };

/** Development reads. Independent of inference and the protocol's public pages. */
export interface InspectionStorageReads {
  readInspectionStatus(): StorageResult<{ session: StoredSession; channels: InspectionChannelStatus[] }>;
  /** Newest first. An oversized body becomes a placeholder that advances pagination. */
  readInspectionPage(before?: number): StorageResult<{ entries: InspectionEntry[]; unfinished: ContextTurnOutcome[]; next?: number }>;
  /** Latest retained durable accounting summaries for one channel. */
  readInspectionCalls(channelId: string): StorageResult<ModelCallSummary[]>;
}
