import { answerForwardedWorkerPermission } from "../permissions/conversation.ts";
import type { FindGivingConversation } from "./permissions.ts";
import { isAgentConversationId } from "../agent-ids.ts";
import type { AgentConversationManager } from "../agent/config.ts";
import { WorkerPolicyError } from "../errors.ts";
import { resolveDelegationToolNames, type OrchestratorConfig } from "./config.ts";
import type { SendWorkerInput, WorkerActor } from "./contracts.ts";
import type { Orchestrator } from "./orchestrator.ts";
import { composeDelegationPolicy } from "./policy.ts";
import { WORKER_SEND_DESCRIPTION } from "./tool-descriptions.ts";
import { ownPermissions } from "../permissions/policy.ts";
import { FunctionError, type NativeFunction, type NativeFunctionContext, type NativeFunctionsConfig } from "../native/functions.ts";

const string = { type: "string" } as const;
const handleOnly = { type: "object", properties: { worker: string }, required: ["worker"], additionalProperties: false };
const denyDelegation = { use: false, scope: "none", redirect: false } as const;
const askWorker = { default: "ask" } as const;

export function withDelegationTools(
  functions: NativeFunctionsConfig | undefined,
  config: OrchestratorConfig,
  orchestrator: () => Orchestrator,
  conversations: () => Pick<AgentConversationManager, "get">,
  names = resolveDelegationToolNames(config.toolNames, config.workerApprovals),
  findGivingConversation?: FindGivingConversation,
): NativeFunctionsConfig {
  for (const name of Object.values(names)) {
    if (functions && Object.hasOwn(functions.tools, name)) throw new Error(`native delegation tool name is already registered: ${name}`);
  }
  const policies = new Map(Object.entries(config.policies ?? {}).map(([name, policy]) => [name, {
    delegation: Object.freeze({ ...policy.delegation }),
    permissions: ownPermissions(policy.workerPermissions) ?? askWorker,
  }]));
  const defaults = {
    delegation: Object.freeze({ ...(config.defaults?.delegation ?? denyDelegation) }),
    permissions: ownPermissions(config.defaults?.workerPermissions) ?? askWorker,
  };
  const ownerPolicies = new Set(config.ownerPolicies ?? ["owner"]);

  async function actor(context: NativeFunctionContext): Promise<WorkerActor> {
    const { channel, invocationId, policyNames, signal } = context;
    if (!Array.isArray(policyNames)) throw new FunctionError("delegation_policy_unknown", "Missing delegation policy names");
    const applicable = policyNames.length ? policyNames.map(name => {
      const policy = policies.get(name);
      if (!policy) throw new FunctionError("delegation_policy_unknown", "A contributing policy has no delegation rules");
      return policy;
    }) : [defaults];
    signal.throwIfAborted();
    if (!isAgentConversationId(channel)) throw new FunctionError("delegation_conversation_unavailable", "Unknown giving conversation");
    const summary = await conversations().get(channel);
    if (!summary || summary.deletedAt || summary.controllerKind === "acp") {
      throw new FunctionError("delegation_conversation_unavailable", "Unknown giving conversation");
    }
    if (!context.takenSender) throw new FunctionError("delegation_sender_unavailable", "No taken-input lookup is available");
    const sender = await context.takenSender();
    signal.throwIfAborted();
    return {
      kind: "conversation", conversationId: channel, destinationKind: "native", sender, invocationId, policyNames: [...policyNames],
      policy: composeDelegationPolicy(applicable.map(policy => policy.delegation)),
      workerPermissions: applicable.map(policy => policy.permissions),
      isOwner: policyNames.length > 0 && policyNames.every(name => ownerPolicies.has(name)),
    };
  }

  function tool(description: string, parameters: Record<string, unknown>, call: (
    args: Record<string, unknown>, actor: WorkerActor,
  ) => Promise<unknown>): NativeFunction {
    return {
      description, parameters, group: "fixed",
      async handler(args, context) {
        try {
          return await call(args, await actor(context));
        } catch (error) {
          if (error instanceof WorkerPolicyError) throw new FunctionError("delegation_policy_denied", error.message);
          throw error;
        }
      },
    };
  }

  return {
    ...functions,
    tools: {
      ...functions?.tools,
      ...(names.answer ? { [names.answer]: tool(
        "Answer a pending worker approval for this conversation. Use the request and one-time choice from the current pending approval context.",
        { type: "object", properties: { request: string, option: { type: "string", enum: ["allow_once", "reject_once"] } },
          required: ["request", "option"], additionalProperties: false },
        async (args, caller) => ({
          status: caller.kind === "conversation" && await answerForwardedWorkerPermission(
            findGivingConversation?.(caller.conversationId), args.request as string, args.option as string, caller.policyNames,
          ) ? "answered" : "request_unavailable",
        }),
      ) } : {}),
      [names.delegate]: tool(`Omit worker to open a worker. ${WORKER_SEND_DESCRIPTION}`, {
        type: "object",
        properties: { worker: string, text: string, about: string, redirect: { type: "boolean" },
          assignment: { type: "string", enum: ["new"] } },
        required: ["text"], additionalProperties: false,
      }, async (args, actor) => {
        const input = args as unknown as SendWorkerInput & { worker?: string };
        if (input.worker !== undefined) return orchestrator().send(actor, input.worker, input);
        if (input.assignment !== undefined || input.redirect !== undefined) {
          throw new FunctionError("invalid_arguments", "assignment and redirect require an existing worker handle");
        }
        return orchestrator().open(actor, input);
      }),
      [names.check]: tool("Check a worker by handle, including its latest staged result and delivery state. Results for native destinations may be absent until the harness opens.", handleOnly,
        (args, actor) => orchestrator().check(actor, args.worker as string)),
      [names.list]: tool("List visible workers with their latest staged results and delivery states. Results for native destinations may be absent until the harness opens.", { type: "object", properties: {}, additionalProperties: false },
        (_args, actor) => orchestrator().list(actor)),
      [names.stop]: tool('Interrupt running work and clear pending prompts. Returns "stopped" after an interruption or "idle" if there was no work to stop.', handleOnly,
        async (args, actor) => ({ status: await orchestrator().stop(actor, args.worker as string) })),
    },
  };
}
