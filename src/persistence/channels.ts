/** Desired channel fields. Omit a field to retain its previous value, or use null to clear it. */
export interface ChannelDesire {
  displayName?: string | null;
  policy?: string | null;
  lifecycle?: "open" | "suspended" | "retired";
}

/** An unconfirmed channel edit. Its version is the wire change ID. */
export interface PendingChange {
  readonly channel: string;
  readonly version: number;
  readonly desire: ChannelDesire;
}

/** Durable channel intents, also available inside an Agent persistence transaction. */
export interface ChannelPersistence {
  /** Merges the provided fields into the pending intent and allocates a new version. */
  desire(channel: string, desire: ChannelDesire): Promise<PendingChange>;
  pendingChange(channel: string): Promise<PendingChange | undefined>;
  pendingChanges(): Promise<PendingChange[]>;
  /** Clears only the version confirmed by the harness. */
  confirmChange(channel: string, version: number): Promise<boolean>;
}
