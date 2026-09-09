/** One positional argument accepted by a discoverable local command. */
export interface CommandArgumentDescriptor {
  /** Stable machine-readable argument name. */
  readonly name: string;
  /** Human-readable explanation suitable for command palettes and help text. */
  readonly description: string;
  readonly required: boolean;
  /** Whether this argument consumes the remaining input rather than one token. */
  readonly variadic?: boolean;
}

/** Metadata shared by the logical-session and low-level controller command surfaces. */
export interface CommandDescriptor<Id extends string = string> {
  readonly id: Id;
  /** Compact terminal representation retained for help output and compatibility. */
  readonly usage: string;
  readonly description: string;
  readonly arguments: readonly CommandArgumentDescriptor[];
  readonly available: boolean;
  /** Present only when the command is currently unavailable. */
  readonly unavailableReason?: string;
}
