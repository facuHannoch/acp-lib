import { afterEach } from "bun:test";
import type { AgentSession } from "../../src/agent-session.ts";
import { runConformance, type OpenConversation, type Seen, type Subject } from "../conversation-controller/conformance.ts";
import { hold, nativeRig, reply, type NativeRig } from "./support.ts";

const rigs: NativeRig[] = [];
afterEach(async () => { for (const rig of rigs.splice(0)) await rig.clean(); });

const nativeSubject: Subject = {
  name: "the NativeController (scripted stdio harness)",
  backendScheduled: true,
  async open(options): Promise<OpenConversation> {
    const rig = await nativeRig();
    rigs.push(rig);
    const agent = await rig.open(options?.stale ? { operationLifecycle: { turns: { firstOutputMs: 30, nextOutputMs: 30 } } } : {});
    const timeline: string[] = [];
    agent.events.subscribe((notification) => { timeline.push(`record:${(notification.event.record as unknown as { recordId: string }).recordId}`); });
    const session = await agent.conversations.create() as AgentSession;
    const events: Seen[] = [];
    session.subscribe(({ event }) => {
      events.push(event as Seen);
      if (event.kind.startsWith("turn_")) timeline.push(`event:${event.kind}:${(event as { turnId: string }).turnId}`);
    });
    const internals = session as unknown as { ownerLifecycle: { afterPrompt: (input: { operationId: string }) => Promise<unknown> } };
    let gate: Promise<void> = Promise.resolve();
    const afterPrompt = internals.ownerLifecycle.afterPrompt.bind(internals.ownerLifecycle);
    internals.ownerLifecycle.afterPrompt = async (input) => {
      timeline.push(`afterPrompt_held:${input.operationId}`);
      await gate;
      const result = await afterPrompt(input);
      timeline.push(`afterPrompt:${input.operationId}`);
      return result;
    };
    return {
      agent, session, events, timeline,
      isRunning: () => session.state.operation?.stage === "tool_running",
      slow() {
        rig.script([hold("k", "slow"), reply("slow reply"), ...Array.from({ length: 8 }, (_, index) => reply(`reply ${index + 1}`))]);
        return { text: "slow", release: () => rig.release("k") };
      },
      silent() {
        rig.env.HARNESS_TEST_STALL_CHANNEL = session.id;
        return "silent";
      },
      async breakProvider() {
        await agent.nativeHarness!.stop();
        rig.breakLaunch(new Error("backend unreachable"));
      },
      holdFinalization() {
        let release!: () => void;
        gate = new Promise<void>((resolve) => { release = resolve; });
        return { release };
      },
    };
  },
};

runConformance(nativeSubject);
