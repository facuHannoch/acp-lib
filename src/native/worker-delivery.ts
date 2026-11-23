import type { WorkerDelivery, WorkerDeliveryRepository, WorkerDeliveryState } from "../persistence/worker-delivery-contract.ts";
import { codeOf } from "./errors.ts";

export class NativeWorkerDelivery {
  private running?: Promise<void>;
  private requested = false;

  constructor(
    private readonly repository: WorkerDeliveryRepository,
    private readonly available: () => boolean,
    private readonly send: (delivery: WorkerDelivery) => Promise<boolean>,
  ) {}

  flush(): Promise<void> {
    this.requested = true;
    return this.running ??= this.drain().finally(() => { this.running = undefined; });
  }

  async hasWork(): Promise<boolean> {
    for (const state of ["pending", "unstaged"] as const) {
      if ((await this.repository.discoverAssignments({ destinationKind: "native", state, limit: 1 })).assignments.length) return true;
    }
    return false;
  }

  private async drain(): Promise<void> {
    while (this.requested && this.available()) {
      this.requested = false;
      for (const state of ["unstaged", "pending"] as const) {
        let after: string | undefined;
        do {
          if (!this.available()) return;
          const page = await this.repository.discoverAssignments({ destinationKind: "native", state, after });
          for (const assignment of page.assignments) {
            if (!this.available()) return;
            if (assignment.state === "unstaged") await this.repository.stage(assignment.binding.assignmentId);
            else await this.deliver(assignment.staged.delivery);
          }
          after = page.next;
        } while (after !== undefined);
      }
    }
  }

  private async deliver(delivery: WorkerDelivery): Promise<void> {
    if (delivery.destination.kind !== "native") return;
    let state: Exclude<WorkerDeliveryState, "pending">;
    try {
      if (!await this.send(delivery)) return;
      state = "delivered";
    } catch (error) {
      switch (codeOf(error)) {
        case "invalid_policy": state = "blocked_policy"; break;
        case "not_found":
        case "channel_retired": state = "failed_destination"; break;
        default: return;
      }
    }
    await this.repository.transitionDelivery(delivery.id, { from: "pending", to: state });
  }
}
