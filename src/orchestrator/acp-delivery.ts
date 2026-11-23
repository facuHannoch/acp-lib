import { isAgentConversationId, type AgentConversationId } from "../agent-ids.ts";
import { AppendDestinationUnavailableError } from "../agent/append-assistant-message.ts";
import type { Logger } from "../logger.ts";
import type { AppendAssistantMessageInput } from "../out-of-band-messages.ts";
import type { StagedWorkerAssignment, WorkerDeliveryRepository } from "../persistence/worker-delivery-contract.ts";
import { REFUSED_STEER_REASONS } from "../persistence/worker-terminal-reason.ts";

export class AcpWorkerDelivery {
  private tail = Promise.resolve();

  constructor(
    private readonly repository: WorkerDeliveryRepository,
    private readonly append: (id: AgentConversationId, input: AppendAssistantMessageInput, stableId: string) => Promise<unknown>,
    private readonly log: Logger,
  ) {}

  flush(): Promise<void> {
    this.tail = this.tail.then(() => this.drain()).catch(error => {
      this.log.warn("acp_worker_delivery_failed", { error: String(error) });
    });
    return this.tail;
  }

  private async drain(): Promise<void> {
    for (const state of ["unstaged", "pending"] as const) {
      let after: string | undefined;
      do {
        const page = await this.repository.discoverAssignments({ destinationKind: "acp", state, after });
        for (const entry of page.assignments) {
          if (entry.state === "pending") await this.deliver(entry.staged);
          else await this.repository.stage(entry.binding.assignmentId);
        }
        after = page.next;
      } while (after !== undefined);
    }
  }

  private async deliver({ delivery, outcome }: StagedWorkerAssignment): Promise<void> {
    if (delivery.destination.kind !== "acp") return;
    const target = delivery.destination.id;
    const reason = "reason" in outcome ? outcome.reason : undefined;
    const cause = reason === REFUSED_STEER_REASONS.conflict ? "conflict"
      : reason === REFUSED_STEER_REASONS.hook_error ? "hook_error" : undefined;
    let state: "delivered" | "failed_destination";
    try {
      if (!isAgentConversationId(target)) throw new AppendDestinationUnavailableError("invalid ACP destination");
      await this.append(target, {
        text: delivery.text,
        consumerMetadata: {
          kind: outcome.kind === "result" ? "worker_reply" : "worker_failed",
          sender: delivery.source,
          ...(outcome.kind === "result" ? {} : {
            errorKind: outcome.kind,
            ...(cause ? { reason: "refused", cause } : reason ? { reason } : {}),
          }),
        },
      }, delivery.id);
      state = "delivered";
    } catch (error) {
      if (!(error instanceof AppendDestinationUnavailableError)) {
        this.log.warn("acp_worker_append_unconfirmed", { deliveryId: delivery.id, error: String(error) });
        return;
      }
      state = "failed_destination";
    }
    await this.repository.transitionDelivery(delivery.id, { from: "pending", to: state });
  }
}
