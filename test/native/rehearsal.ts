import { createStdioTransport, HarnessClient, type ChannelEvent, type ProtocolConfig } from "../../src/native-harness/src/client.ts";
import { loadScenario } from "../../src/native-harness/src/testing.ts";
import { NativeHarnessHost, type ChannelPort, type NativeApprovalResponder } from "../../src/native/host.ts";
import type { NativeFunctionsConfig } from "../../src/native/functions.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const main = new URL("../../src/native-harness/src/interfaces/cli/main.ts", import.meta.url).pathname;
type Outcome = "completed" | "failed" | "interrupted";
type ExpectedOutcome = Outcome | "timeout";
type Send = { inputId: string; channel: string; scheduled: number; issued: number; accepted?: boolean; turnId?: string; outcome?: Outcome; reason?: string };
type Evidence = { channel: string; turnId: string; kind: "started" | "text_delta" | Outcome; elapsed: number; characters?: number };

export interface RehearsalOptions {
  deadlineMs: number;
  cleanupMs?: number;
  functions?: NativeFunctionsConfig;
  approvalResponder?: NativeApprovalResponder;
  policies?: ProtocolConfig["policies"];
  expected?: Readonly<Record<string, ExpectedOutcome>>;
  channels?: readonly string[];
  env?: Record<string, string>;
  exactConsumption?: boolean;
  timelineTools?: boolean;
  imageInput?: boolean;
  webSearch?: ProtocolConfig["webSearch"];
  webFetch?: ProtocolConfig["webFetch"];
  mcpServers?: ProtocolConfig["mcpServers"];
  /** Trusted offline test assembly entry point. */
  testEntrypoint?: string;
}

export async function createRehearsal(path: string, options: RehearsalOptions) {
  for (const timeout of [options.deadlineMs, options.cleanupMs ?? 1000]) {
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2_147_483_647)
      throw new Error("Rehearsal time budgets must be positive timer-safe integers");
  }
  const scenario = await loadScenario(path);
  const home = await mkdtemp(join(tmpdir(), "native-rehearsal-"));
  const env = { ...options.env };
  const children: ReturnType<typeof Bun.spawn<"pipe", "pipe", "pipe">>[] = [];
  let currentClient: HarnessClient | undefined;
  const exits: number[] = [];
  const effects: { tool: string; channel: string; invocationId: string; outcome: "completed" | "failed" }[] = [];
  const functions = options.functions && { ...options.functions, tools: Object.fromEntries(Object.entries(options.functions.tools).map(([name, definition]) =>
    [name, { ...definition, async handler(...args: Parameters<typeof definition.handler>) {
      const { channel, invocationId } = args[1];
      try {
        const result = await definition.handler(...args);
        effects.push({ tool: name, channel, invocationId, outcome: "completed" });
        return result;
      } catch (error) {
        effects.push({ tool: name, channel, invocationId, outcome: "failed" });
        throw error;
      }
    } }])) };
  const host = new NativeHarnessHost({
    sessionId: "rehearsal", home, functions, approvalResponder: options.approvalResponder, text: "stream",
    config: { version: 1, system: "Offline rehearsal", model: { protocol: "scripted", script: path, ...(options.imageInput ? { imageInput: true } : {}) },
      timelineTools: options.timelineTools, ...(options.mcpServers ? { mcpServers: options.mcpServers } : {}), ...(options.webSearch ? { webSearch: options.webSearch } : {}), ...(options.webFetch ? { webFetch: options.webFetch } : {}), defaultPolicy: "rehearsal", policies: options.policies ?? { rehearsal: { fallback: "allow", tools: {} } } },
    requestTimeoutMs: 8000,
    async connect() {
      const child = Bun.spawn([process.execPath, options.testEntrypoint ?? main, "serve", "--stdio", "--home", home], {
        stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, OPENROUTER_API_KEY: undefined, HARNESS_TEST_REQUESTS: undefined, ...env },
      });
      children.push(child);
      void child.exited.then(code => exits.push(code));
      void child.stderr.pipeTo(new WritableStream({ write() {} })).catch(() => undefined);
      const transport = createStdioTransport({ readable: child.stdout, exited: child.exited,
        async write(bytes) { child.stdin.write(bytes); await child.stdin.flush(); },
        async end() { await child.stdin.end(); },
      });
      const client = new HarnessClient(transport, 8000);
      currentClient = client;
      return { client, closed: child.exited.then(() => undefined), async kill() { client.close(); await child.exited; } };
    },
  });
  const channels = new Set([...scenario.channelModels.keys(), ...scenario.sends.map(send => send.channelId), ...(options.channels ?? [])]);
  const deliveries = new Map<string, Map<string, number>>();
  const ended = new Map<string, Outcome>();
  const seen = new Set<string>();
  const toolFailures: { channel: string; turnId: string; name: string; status: string }[] = [];
  const activity: Evidence[] = [];
  const sends: Send[] = [];
  const tracked = new Map<string, Set<string>>();
  const requests: Promise<unknown>[] = [];
  let started = performance.now(), failure: unknown;
  const elapsed = () => Math.round(performance.now() - started);
  const key = (channel: string, turn: string) => JSON.stringify([channel, turn]);
  const end = (channel: string, turnId: string, outcome: Outcome) => {
    if (ended.has(key(channel, turnId))) return;
    ended.set(key(channel, turnId), outcome);
    activity.push({ channel, turnId, kind: outcome, elapsed: elapsed() });
  };
  const count = (channel: string, messageId: string, recovered = false) => {
    const channelReplies = deliveries.get(channel) ?? new Map<string, number>();
    if (!recovered || !channelReplies.has(messageId)) channelReplies.set(messageId, (channelReplies.get(messageId) ?? 0) + 1);
    deliveries.set(channel, channelReplies);
  };
  const ports = new Map<string, ChannelPort>(), detach = new Map<string, () => void>();
  for (const channel of channels) {
    const turns = new Set<string>();
    tracked.set(channel, turns);
    ports.set(channel, {
      event({ event }: ChannelEvent) {
        if (event.type === "turn_started" || event.type === "turn_resumed") {
          turns.add(event.turnId);
          if (!seen.has(key(channel, event.turnId))) {
            seen.add(key(channel, event.turnId));
            activity.push({ channel, turnId: event.turnId, kind: "started", elapsed: elapsed() });
          }
        }
        if (event.type === "text_delta") activity.push({ channel, turnId: event.turnId, kind: "text_delta", elapsed: elapsed(), characters: event.text.length });
        if (event.type === "tool_call" && ["failed", "skipped", "interrupted"].includes(event.status))
          toolFailures.push({ channel, turnId: event.turnId, name: event.name, status: event.status });
        if (event.type === "message_completed" && event.messageId) count(channel, event.messageId);
        if (event.type === "turn_ended") { turns.delete(event.turnId); end(channel, event.turnId, event.outcome); }
      },
      reconcile(view) {
        for (const message of view.messages) count(channel, message.messageId, true);
        for (const turn of view.turns) {
          if (turn.state === "interrupted" || turn.state === "failed" || turn.state === "completed") { turns.delete(turn.turnId); end(channel, turn.turnId, turn.state); }
        }
      },
      disconnected() {},
      failed() {},
      busy: () => turns.size > 0,
      trackedTurns: () => [...turns],
    });
  }

  const observe = (channel: string) => {
    if (detach.has(channel)) return;
    const port = ports.get(channel);
    if (!port) throw new Error(`Unknown rehearsal channel ${channel}`);
    detach.set(channel, host.attach(channel, port, true));
    return host.observeAttachment(channel, port);
  };
  const unobserve = (channel: string) => {
    detach.get(channel)?.();
    detach.delete(channel);
  };
  const recover = async (channel: string, after: string) => {
    await observe(channel);
    return host.catchUp(channel, after, async messages => {
      for (const message of messages) if (message.actor.kind === "agent") count(channel, message.messageId, true);
    });
  };
  const setup = async () => {
    for (const channel of channels) {
      await host.changeChannel(channel, { lifecycle: "open" });
      await observe(channel);
    }
    await host.start();
    started = performance.now();
  };
  let stage = "startup";
  const issue = (send: typeof scenario.sends[number]) => {
    const record: Send = { inputId: send.inputId, channel: send.channelId, scheduled: send.atMs, issued: elapsed() };
    sends.push(record);
    const request = host.push({ id: send.inputId, channel: send.channelId, sender: send.participantId, text: send.text });
    requests.push(request.then(() => { record.accepted = true; }, error => { failure ??= error; }));
    return request;
  };
  const schedule = async (beforeBurst?: (offset: number) => Promise<void>) => {
    stage = "scheduled sends";
    let previous: number | undefined;
    const ordered = [...scenario.sends].sort((a, b) => a.atMs - b.atMs);
    for (const send of ordered) {
      while (send.atMs > elapsed()) await Bun.sleep(Math.min(50, send.atMs - elapsed()));
      if (send.atMs !== previous) await beforeBurst?.(send.atMs);
      previous = send.atMs;
      if (elapsed() >= options.deadlineMs) throw new Error("rehearsal deadline before all sends");
      void issue(send).catch(() => undefined);
    }
    stage = "inbox acknowledgments";
    await Promise.all(requests);
  };
  const settled = async () => {
    if (failure) throw failure;
    const status = await host.status();
    if (status.execution !== "idle" || status.channels.some(channel => channel.pending.length || channel.activeTurn)) return;
    stage = "input reconciliation";
    for (const channel of channels) {
      const submitted = sends.filter(send => send.channel === channel);
      const inputTurns = new Map<string, string>();
      for (let offset = 0; offset < submitted.length; offset += 100) {
        const itemIds = submitted.slice(offset, offset + 100).map(send => send.inputId);
        const page = await host.reconcileChannel({ channel, itemIds });
        for (const item of page.items) if (item.turnId) inputTurns.set(item.id, item.turnId);
      }
      if (inputTurns.size !== submitted.length) return;
      const turnIds = [...new Set(inputTurns.values())];
      const outcomes = new Map<string, Awaited<ReturnType<typeof host.reconcileChannel>>["turns"][number]>();
      for (let offset = 0; offset < turnIds.length; offset += 100) {
        const page = await host.reconcileChannel({ channel, turnIds: turnIds.slice(offset, offset + 100) });
        for (const turn of page.turns) outcomes.set(turn.turnId, turn);
      }
      for (const send of submitted) {
        const turn = outcomes.get(inputTurns.get(send.inputId)!);
        if (!turn || turn.state === "running" || turn.state === "suspended") return;
        send.turnId = turn.turnId; send.outcome = turn.state; send.reason = turn.reason;
        const expected = options.expected?.[send.inputId] ?? "completed";
        const actual = expected === "timeout" && turn.state === "failed" && turn.reason === "timeout" ? "timeout" : turn.state;
        if (actual !== expected) throw new Error(`Unexpected outcome for ${send.inputId}: ${turn.state}`);
      }
    }
    return status;
  };
  const finish = async () => {
    while (elapsed() < options.deadlineMs) {
      stage = "channel settlement";
      const status = await settled();
      if (!status) { await Bun.sleep(10); continue; }
      // The driver owns a fresh home for the whole run, including replacements.
      // A tested channel's entire history is exactly its run delivery window.
      stage = "reply comparison";
      const comparisonStarted = performance.now();
      let historyPages = 0;
      const expectedReplies = new Map<string, string[]>();
      for (const channel of channels) {
        const ids: string[] = [];
        for (let cursor: string | undefined; ;) {
          historyPages++;
          const page = await host.conversationMessages(cursor === undefined ? { channel } : { channel, cursor });
          for (const message of page.messages) if (message.actor.kind === "agent") ids.push(message.messageId);
          if (!page.next) break;
          cursor = page.next;
        }
        expectedReplies.set(channel, ids);
      }
      if ((await host.status()).revision !== status.revision) continue;
      const comparisonMs = Math.round(performance.now() - comparisonStarted);
      for (const [channel, ids] of expectedReplies) {
        const matches = deliveries.get(channel) ?? new Map();
        if (matches.size !== ids.length || ids.some(id => matches.get(id) !== 1))
          throw new Error(`Missing or repeated committed reply delivery on ${channel}`);
      }
      for (const entry of activity) if (entry.kind === "failed" || entry.kind === "interrupted") {
        if (!sends.some(send => send.channel === entry.channel && send.turnId === entry.turnId && (options.expected?.[send.inputId] === entry.kind || (entry.kind === "failed" && options.expected?.[send.inputId] === "timeout" && send.reason === "timeout"))))
          throw new Error(`Unexpected ${entry.kind} turn on ${entry.channel}`);
      }
      for (const tool of toolFailures) {
        const turn = ended.get(key(tool.channel, tool.turnId));
        if (turn === "completed") throw new Error(`Unexpected tool ${tool.status}: ${tool.name} on ${tool.channel} turn ${tool.turnId}`);
      }
      const consumed = new Map<string, number>();
      for (let after: string | undefined; ;) {
        const page = await host.modelCalls({ after });
        for (const call of page.calls) for (const attempt of call.attempts) if (attempt.scriptStep !== undefined)
          consumed.set(call.channel, Math.max(consumed.get(call.channel) ?? 0, attempt.scriptStep + 1));
        if (!page.next) break;
        after = page.next;
      }
      const unused = Object.fromEntries([...channels].map(channel => [channel, Math.max(0,
        (scenario.channelModels.get(channel) ?? scenario.defaultModels).length - (consumed.get(channel) ?? 0))]));
      if (options.exactConsumption && Object.values(unused).some(count => count !== 0))
        throw new Error(`Unused model records: ${JSON.stringify(unused)}`);
      return { fixture: scenario.name, fileDigest: scenario.fileDigest, durationMs: elapsed(), revision: status.revision, sends, activity,
        replies: Object.fromEntries(expectedReplies), historyPages, comparisonMs, effects, toolFailures, unused };
    }
    throw new Error("rehearsal deadline before all work settled");
  };
  const close = async () => {
    const stop = host.stop().catch(() => undefined);
    const budget = options.cleanupMs ?? 1000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([stop, new Promise(resolve => { timer = setTimeout(resolve, budget / 2); })]); }
    finally { clearTimeout(timer); }
    for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
    try {
      await Promise.race([Promise.all(children.map(child => child.exited)),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("rehearsal child did not exit within cleanup budget")), budget / 2); })]);
    } finally { clearTimeout(timer); }
    await rm(home, { recursive: true, force: true });
  };
  const run = async (beforeBurst?: (offset: number) => Promise<void>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await setup();
      return await Promise.race([(async () => { await schedule(beforeBurst); return finish(); })(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("rehearsal deadline")), options.deadlineMs); })]);
    } catch (error) {
      let diagnosticTimer: ReturnType<typeof setTimeout> | undefined;
      const status = await Promise.race([
        host.operatorStatus().then(view => ({
          process: view.process, stale: view.stale, workingChannels: view.workingChannels,
          revision: view.session?.revision, execution: view.session?.execution, lifecycle: view.session?.lifecycle,
          channels: view.session?.channels.filter(channel => channel.pending.length || channel.activeTurn || channel.waitingForResume)
            .slice(0, 12).map(channel => ({
              channel: channel.channel, lifecycle: channel.lifecycle, waitingForResume: channel.waitingForResume,
              pendingCount: channel.pending.length, pending: channel.pending.slice(0, 5), activeTurn: channel.activeTurn,
            })),
        }), error => ({ statusError: String(error).slice(0, 200) })),
        new Promise(resolve => { diagnosticTimer = setTimeout(() => resolve({ statusError: "operator status timed out" }), 250); }),
      ]);
      clearTimeout(diagnosticTimer);
      const unissued = scenario.sends.length - sends.length;
      const awaitingReceipt = sends.filter(send => !send.accepted);
      const unresolved = sends.filter(send => !send.outcome);
      throw new Error(`${String(error)}; blocking status: ${JSON.stringify({ stage, unissued, awaitingReceipt: awaitingReceipt.length,
        unresolved: unresolved.length, sample: unresolved.slice(0, 8).map(send => send.inputId), ...status })}`, { cause: error });
    } finally { clearTimeout(timer); await close(); }
  };
  return { host, env, children, exits, effects, sends, activity, scenario, setup, issue, schedule, finish, observe, unobserve, recover, close, run,
    client: () => { if (!currentClient) throw new Error("Rehearsal has not started"); return currentClient; },
    crash: () => { const child = children.at(-1)!; child.kill("SIGKILL"); return child.exited; } };
}
