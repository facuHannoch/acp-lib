import type { AssignmentPlan, RunningAssignment } from "./assignments.ts";
import type { SendWorkerInput, WorkerActor } from "./contracts.ts";

export function planAssignment(
  actor: WorkerActor, input: SendWorkerInput, running?: RunningAssignment,
): AssignmentPlan | undefined {
  const destination = actor.kind === "conversation" ? actor.conversationId : undefined;
  const fresh = () => ({ id: actor.kind === "conversation" ? actor.invocationId : crypto.randomUUID(), destination });
  if (!running) return { kind: "start", assignment: fresh() };
  if (destination !== running.destination && !input.redirect) return;
  if (input.assignment === "new") return { kind: "replace", previous: running, assignment: fresh() };
  return { kind: "continue", previous: running, assignment: { ...running, destination } };
}
