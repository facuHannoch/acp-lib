#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { Agent } from "../../src/index.ts";
import type { ConversationPermissionEvent } from "../../src/permissions/conversation.ts";
import { createInProcessHarness } from "../../src/native-harness/src/testing.ts";
import { checkWorkerMode, commandInput, permissionTrace, workerMode } from "./codex-permissions.ts";
import { openRouter } from "../../src/native-harness/src/capabilities/model/openrouter.ts";

const nativeModel = process.env.ACP_ORCH_NATIVE_MODEL || "deepseek/deepseek-v4.1-flash";
const workerModel = process.env.ACP_ORCH_WORKER_MODEL || "gpt-6.1-terra";

const codexAcp = Bun.which("codex-acp");
if (process.env.ACP_ORCH_LIVE !== "1") {
  const mode = codexAcp ? await checkWorkerMode(codexAcp) : "Bridge not installed; cannot verify the live mode";
  console.log(JSON.stringify({ mode: "scripted", plannedLiveModels: { native: nativeModel, worker: workerModel },
    plannedWorkerPermissions: mode }));
  const test = new URL("../../test/orchestrator/native-delivery.test.ts", import.meta.url).pathname;
  process.exit(await Bun.spawn([process.execPath, "test", test, "-t", "stdio delegation redirects"],
    { stdin: "ignore", stdout: "inherit", stderr: "inherit" }).exited);
}

const codex = join(homedir(), ".local/bin/codex");
const configuredCodexHome = process.env.ACP_ORCH_CODEX_HOME;
if (!process.env.OPENROUTER_API_KEY || !configuredCodexHome || !existsSync(codex)) {
  throw new Error("Live mode requires OpenRouter environment authentication, Codex, and a disposable ACP_ORCH_CODEX_HOME");
}
const codexHome = await realpath(configuredCodexHome);
const home = await realpath(homedir());
const usualHome = join(home, ".codex");
const protectedHomes = [usualHome, ...(existsSync(usualHome) ? [await realpath(usualHome)] : [])];
if (codexHome === home || protectedHomes.some(path => containsPath(path, codexHome) || containsPath(codexHome, path))) {
  throw new Error("Use a disposable Codex home that does not overlap the normal Codex home");
}
if (!codexAcp) throw new Error("The installed codex-acp binary is required");
await checkWorkerMode(codexAcp);

function check(condition: unknown, failure: string): asserts condition {
  if (!condition) throw new Error(failure);
}

function containsPath(parent: string, child: string): boolean {
  const suffix = relative(parent, child);
  return suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

const start = performance.now();
const root = await mkdtemp(join(tmpdir(), "acp-orch-live-"));
const deadline = new AbortController();
const timer = setTimeout(() => deadline.abort(new Error("Live work deadline reached")), 7 * 60_000);
const onInterrupt = () => deadline.abort(new Error("Live run interrupted"));
const onTerminate = () => deadline.abort(new Error("Live run terminated"));
process.on("SIGINT", onInterrupt);
process.on("SIGTERM", onTerminate);
let agent: Agent | undefined;
let nativeCalls = 0;
let workerSubmissions = 0;
let phase = "initialization";
let trace: ReturnType<typeof permissionTrace> | undefined;
let diagnosticPhase: string | undefined;
const replies: string[] = [];
const evidence = { aliceAsked: false, bobSteerQueued: false, bobAnswerRejected: false,
  aliceAnswerAccepted: false, resolutions: 0, redirectReported: false };

function mismatch(reason: string) {
  if (!deadline.signal.aborted) diagnosticPhase = phase;
  deadline.abort(new Error(reason));
}

function safe(message: string): string {
  return message.replaceAll(process.env.OPENROUTER_API_KEY!, "[REDACTED]").replaceAll(root, "[run root]");
}

function bounded<T>(promise: Promise<T>): Promise<T> {
  deadline.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(deadline.signal.reason);
    deadline.signal.addEventListener("abort", abort, { once: true });
    void promise.then(resolve, reject).finally(() => deadline.signal.removeEventListener("abort", abort));
  });
}

try {
  const work = join(root, "worker"), output = join(root, "result.txt");
  await mkdir(work, { mode: 0o700 });
  const login = Bun.spawn([codex, "login", "status"], {
    env: { HOME: homedir(), PATH: process.env.PATH, CODEX_HOME: codexHome },
    stdin: "ignore", stdout: "ignore", stderr: "ignore",
  });
  check(await bounded(login.exited) === 0, "The isolated Codex home cannot authenticate");

  const command = `echo 'orch live ok' > ${output}`;
  trace = permissionTrace(join(root, "worker-permissions.jsonl"), command, mismatch);
  const first = `Run exactly the shell command on the next line. Ask me for one-time approval when required. Use no other tools or files. Then reply exactly orch live ok.\n${command}`;
  const steer = "Finish the same one-line task only if it is already done. Do not use tools. Reply exactly orch live ok.";
  const home = join(root, "harness");
  const scope = { use: true, scope: "all", redirect: true } as const;
  const workerEnv = {
    CODEX_HOME: codexHome, CODEX_PATH: codex, OPENROUTER_API_KEY: "", INITIAL_AGENT_MODE: workerMode,
    CODEX_CONFIG: JSON.stringify({ model: workerModel, model_reasoning_effort: "low", approval_policy: "on-request", sandbox_mode: "read-only" }),
  };
  // Use the production host with an in-process harness so the provider request cap runs before fetch.
  const connect = async () => {
    const harness = createInProcessHarness({ home, providerFactory: (key, model) => {
      const provider = openRouter(key, model, () => {
        if (nativeCalls >= 6) {
          deadline.abort(new Error("OpenRouter request cap reached"));
          deadline.signal.throwIfAborted();
        }
        nativeCalls += 1;
      });
      return (messages, tools, signal) => provider(messages, tools, signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal);
    } });
    const closed = Promise.withResolvers<void>();
    return { client: harness.client, closed: closed.promise, async kill() { harness.close(); closed.resolve(); } };
  };
  agent = await Agent.open({
    persistence: { kind: "sqlite", path: join(root, "agent.sqlite") },
    adapters: { main: { kind: "native" }, worker: { command: [codexAcp] } },
    defaultAdapterId: "main",
    checkpointing: { enabled: false }, capture: { message: "content" },
    conversationDefaults: { cwd: root, env: workerEnv, logger: trace.logger, metering: { pricing: false } },
    orchestrator: { policies: { owner: { delegation: scope } }, workers: { adapterId: "worker", cwd: work, limit: 1 } },
    harness: {
      home,
      config: { version: 1, system: "Perform only the single tool action requested in each user message, passing its arguments verbatim. After the tool returns, reply once without tools. For an external worker notice, summarize it in one line without tools. Never call other tools.",
        model: { protocol: "openrouter", model: nativeModel, apiKeyEnv: "OPENROUTER_API_KEY" },
        defaultPolicy: "owner", policies: { owner: { fallback: "deny", tools: { delegate: "allow" } } },
      },
      ...{ connect },
    },
  });

  const current = agent;
  const host = current.nativeHarness!;
  const alice = await current.conversations.create({ title: "Live smoke Alice", answersPermissions: true, permissionTimeoutMs: 90_000 });
  const bob = await current.conversations.create({ title: "Live smoke Bob", answersPermissions: true, permissionTimeoutMs: 90_000 });
  const pool = current.orchestrator!;
  const open = pool.open.bind(pool), send = pool.send.bind(pool);
  pool.open = async (actor, input) => {
    if (workerSubmissions !== 0 || actor.kind !== "conversation" || actor.conversationId !== alice.id || input.text !== first) {
      deadline.abort(new Error("Unexpected delegation call"));
      deadline.signal.throwIfAborted();
    }
    workerSubmissions += 1;
    return open(actor, input);
  };
  pool.send = async (actor, handle, input) => {
    if (workerSubmissions !== 1 || actor.kind !== "conversation" || actor.conversationId !== bob.id ||
      handle !== "w1" || input.text !== steer || input.redirect !== true || input.assignment !== undefined) {
      deadline.abort(new Error("Unexpected worker steer"));
      deadline.signal.throwIfAborted();
    }
    workerSubmissions += 1;
    const result = await send(actor, handle, input);
    if (result.status !== "steered") mismatch("Bob's redirect steer was not queued");
    else evidence.bobSteerQueued = true;
    return result;
  };

  type Request = Extract<ConversationPermissionEvent, { kind: "permission_requested" }>;
  type Resolution = Extract<ConversationPermissionEvent, { kind: "permission_resolved" }>;
  const requested = Promise.withResolvers<Request>(), resolved = Promise.withResolvers<Resolution>();
  const redirected = Promise.withResolvers<void>(), idle = Promise.withResolvers<void>();
  const nativeReply = Promise.withResolvers<string>();
  let asks = 0, resolutions = 0, answerStarted = false, cleaningUp = false;
  const cleanupFailures: string[] = [];
  alice.subscribe(({ event }) => {
    if (event.kind === "permission_requested" && event.source?.kind === "worker") {
      if (++asks !== 1) mismatch("Unexpected additional worker permission");
      evidence.aliceAsked = event.source.handle === "w1";
      requested.resolve(event);
    }
    if (event.kind === "permission_resolved") {
      resolutions += 1;
      evidence.resolutions = resolutions;
      if (!answerStarted && !cleaningUp) mismatch("The permission closed before Alice answered");
      resolved.resolve(event);
    }
  });
  bob.subscribe(({ event }) => {
    if (event.kind === "permission_requested" && event.source) mismatch("Unexpected worker permission on Bob");
    if (event.kind === "turn_completed" && nativeCalls >= 5) nativeReply.resolve(event.result.text);
  });
  current.events.subscribeWorkers(({ event }) => {
    if (cleaningUp) return;
    if (event.kind === "worker_redirected") {
      evidence.redirectReported = true;
      redirected.resolve();
    }
    if (event.kind === "worker_idle") {
      if (!answerStarted) mismatch("The worker stopped before the permission was answered");
      idle.resolve();
    }
    if (event.kind === "worker_failed") mismatch("The live worker failed");
  });

  try {
    phase = "delegate";
    const firstReply = await bounded(alice.promptFrom({ participantId: "alice", text:
      `Call delegate exactly once with JSON arguments ${JSON.stringify({ text: first })}. After its return reply queued without further tools.` }));
    replies.push(firstReply.text);
    check(workerSubmissions === 1 && firstReply.status === "completed" && nativeCalls === 2, "Unexpected first native turn");
    phase = "wait for permission";
    const ask = await bounded(requested.promise);
    check(ask.source?.handle === "w1", "Permission did not identify the worker");
    const raw = commandInput(ask.tool?.rawInput);
    check(ask.tool?.kind === "execute" && raw.command === command && !raw.url && !raw.additionalPermissions,
      "The worker requested a different operation than the authorized temporary-file command");
    const allow = ask.options.find(option => option.kind === "allow_once");
    check(allow, "The worker did not offer one-time approval");

    phase = "redirect";
    const secondReply = await bounded(bob.promptFrom({ participantId: "bob", text:
      `Call delegate exactly once with JSON arguments ${JSON.stringify({ worker: "w1", text: steer, redirect: true })}. After its return reply redirected without further tools.` }));
    replies.push(secondReply.text);
    check(secondReply.status === "completed" && Number(workerSubmissions) === 2 && Number(nativeCalls) === 4, "Unexpected redirect turn");
    evidence.bobAnswerRejected = !(await bob.answerPermission(ask.id, allow.optionId)).accepted;
    check(evidence.bobAnswerRejected, "The redirect moved an already-open permission");
    check(resolutions === 0, "The permission closed before the redirect completed");
    answerStarted = true;
    evidence.aliceAnswerAccepted = (await alice.answerPermission(ask.id, allow.optionId)).accepted;
    check(evidence.aliceAnswerAccepted, "The giving conversation rejected the permission answer");
    const decision = await bounded(resolved.promise);
    check(decision.id === ask.id && decision.by === "consumer" && decision.outcome === "approved", "Unexpected permission resolution");

    phase = "receive";
    await bounded(redirected.promise);
    await bounded(idle.promise);
    const reply = await bounded(nativeReply.promise);
    replies.push(reply);
    const notices = (await host.timeline()).events.filter(event => event.kind === "external_notice");
    check(notices.length === 1 && notices[0]?.channel === bob.id && notices[0]?.externalSource === "w1", "Unexpected notice destination or count");
    check(Number(resolutions) === 1 && asks === 1, "Unexpected permission event count");
    check(trace.requests.length === 1 && trace.responses.length === 1 && trace.responses[0] === "allow_once",
      "ACP did not receive exactly one one-time answer");
    const summary = await current.workers!.check("w1");
    check(summary.latestOutcome?.kind === "result" && summary.deliveryState === "delivered", "The worker result did not settle");
    check((await readFile(output, "utf8")).trim() === "orch live ok", "The worker did not write the approved one-line result");
    console.log(JSON.stringify({ nativeModel, workerModel, nativeCalls, workerSubmissions, notices: notices.length,
      permissionSource: ask.source, permissionResolutions: resolutions, redirect: true,
      nativeReplies: replies.map(safe), workerReply: safe(summary.latestOutcome.text) }));
  } finally {
    cleaningUp = true;
    const handles = await current.workers!.list();
    for (const worker of handles) {
      try {
        const result = await current.workers!.delete(worker.handle);
        check((await current.persistence.workers!.get(worker.handle))?.droppedAt, "Worker row was not dropped");
        console.log(JSON.stringify({ dropped: worker.handle, providerDeleted: result.providerDeleted }));
        if (result.providerDeleted !== true) cleanupFailures.push("Provider deletion was not confirmed");
      } catch (error) {
        cleanupFailures.push(safe(String(error)));
      }
    }
    check((await current.workers!.list()).length === 0, "Worker remained visible after drop");
    for (const conversation of [alice, bob]) {
      try {
        await current.conversations.delete(conversation.id);
        check((await current.conversations.get(conversation.id))?.deletedAt, "Native conversation was not marked deleted");
      } catch (error) {
        cleanupFailures.push(safe(String(error)));
      }
    }
    console.log(JSON.stringify({ nativeConversationsDeleted: Number(!!(await current.conversations.get(alice.id))?.deletedAt) +
      Number(!!(await current.conversations.get(bob.id))?.deletedAt) }));
    if (cleanupFailures.length) {
      console.error(JSON.stringify({ cleanupFailures }));
      process.exitCode = 1;
    }
  }
} catch (error) {
  console.error(JSON.stringify({ phase: diagnosticPhase ?? phase, error: safe(String(error)), nativeCalls, workerSubmissions,
    nativeReplies: replies.map(safe) }));
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  try { await agent?.close(); }
  finally {
    console.log(JSON.stringify({ evidence, workerPermissionTrace: {
      requests: trace?.requests ?? [], responses: trace?.responses ?? [],
    } }));
    await rm(root, { recursive: true, force: true });
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
    check(!existsSync(root), "Temporary smoke files remain");
    console.log(JSON.stringify({ tempRemoved: true, durationSeconds: Math.round((performance.now() - start) / 1000) }));
  }
}
