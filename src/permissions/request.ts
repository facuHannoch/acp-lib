export type PermissionOptionKind =
  | "allow_once"
  | "allow_always"
  | "reject_once"
  | "reject_always"
  | (string & {});

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: PermissionOptionKind;
}

/** The tool fields a producer can reliably identify. */
export interface PermissionTool {
  readonly name?: string;
  readonly kind?: string;
  readonly rawInput?: unknown;
}

/** A permission request without transport-specific identity or response routing. */
export interface NeutralPermissionRequest {
  readonly tool: PermissionTool;
  readonly title?: string;
  readonly options: readonly PermissionOption[];
}
