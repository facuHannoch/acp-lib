export class ScriptedModelError extends Error {
  constructor(public readonly code: "invalid_script" | "script_load_failed" | "script_exhausted", message: string) {
    super(message);
    this.name = "ScriptedModelError";
  }
}
