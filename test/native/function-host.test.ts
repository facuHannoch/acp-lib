/** The host side of a function call: routing, the private result store and bounded reads by ID. */
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stallLimitsFor } from "../../src/conversation-controller/guards.ts";
import { createNativeFunctionHost, FunctionError, type NativeFunctionsConfig } from "../../src/native/functions.ts";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const temp = () => { const directory = mkdtempSync(join(tmpdir(), "acp-fn-host-")); directories.push(directory); return directory; };
const call = (handler: string, args: Record<string, unknown> = {}) => ({ invocationId: "1:t1", sessionId: "s", channel: "c", turnId: "1", tool: handler, handler, policyNames: ["main"], arguments: args });
const code = async (work: () => unknown) => { try { await work(); return "ok"; } catch (error) { return error instanceof FunctionError ? error.code : String(error); } };
const schema = { type: "object" };

test("the catalog names each function as its own handler and carries the current runtime selection", () => {
  const config: NativeFunctionsConfig = { defaultDeadlineMs: 500, tools: {
    a: { description: "A", parameters: schema, handler: () => 1 },
    b: { description: "B", parameters: schema, group: "revocable", deadlineMs: 50, handler: () => 2 },
    c: { description: "C", parameters: schema, group: "runtime", enabled: true, handler: () => 3 },
    d: { description: "D", parameters: schema, group: "runtime", handler: () => 4 },
  } };
  const host = createNativeFunctionHost(config);
  expect(host.handlers()).toEqual(["a", "b", "c", "d"]);
  expect(host.catalog()).toEqual({ defaultDeadlineMs: 500, enabled: ["c"], catalog: [
    { name: "a", description: "A", parameters: schema, handler: "a", group: "fixed" },
    { name: "b", description: "B", parameters: schema, handler: "b", group: "revocable", deadlineMs: 50 },
    { name: "c", description: "C", parameters: schema, handler: "c", group: "runtime" },
    { name: "d", description: "D", parameters: schema, handler: "d", group: "runtime" }] });
  host.select("d", true); host.select("c", false);
  expect(host.catalog().enabled).toEqual(["d"]);
});

test("a small output is inline; a handler gets its arguments, identity and signal; an unknown handler and a typed error are typed failures", async () => {
  const seen: unknown[] = [];
  const host = createNativeFunctionHost({ tools: {
    echo: { description: "", parameters: schema, handler: (args, context) => { seen.push([args, context.invocationId, context.channel, context.tool, context.signal.aborted]); return { got: args }; } },
    nothing: { description: "", parameters: schema, handler: () => undefined },
    broken: { description: "", parameters: schema, handler: () => { throw new FunctionError("quota", "none left"); } },
  } });
  const signal = new AbortController().signal;
  expect(await host.call(call("echo", { q: 1 }), signal)).toEqual({ output: { got: { q: 1 } } });
  expect(seen).toEqual([[{ q: 1 }, "1:t1", "c", "echo", false]]);
  expect(await host.call(call("nothing"), signal)).toEqual({ output: null });
  expect(await code(() => host.call(call("missing"), signal))).toBe("handler_missing");
  expect(await code(() => host.call(call("constructor"), signal))).toBe("handler_missing");
  expect(await code(() => host.call(call("broken"), signal))).toBe("quota");
  expect(host.active()).toEqual([]);
});

test("an oversized output is stored privately and read back in bounded parts that never split a character; paths and expired IDs are refused", async () => {
  const directory = join(temp(), "results");
  const text = "añ€😀".repeat(2000); // 1, 2, 3 and 4 byte characters
  let n = 0;
  const host = createNativeFunctionHost({ resultDirectory: directory, inlineBytes: 100, resultTtlMs: 60_000,
    newResultId: () => `00000000-0000-4000-8000-00000000000${++n}`, tools: { big: { description: "", parameters: schema, handler: () => text } } });
  const result = await host.call(call("big"), new AbortController().signal);
  const serialized = JSON.stringify(text), total = Buffer.byteLength(serialized);
  expect(result).toMatchObject({ preview: serialized.slice(0, 512), reference: { resultId: "00000000-0000-4000-8000-000000000001", bytes: total, retention: "temporary" } });
  expect(Date.parse((result as any).reference.expiresAt)).toBeGreaterThan(Date.now());
  expect(readdirSync(directory)).toEqual(["00000000-0000-4000-8000-000000000001"]);
  // Reassemble with an awkward part size: every part is valid text and the offsets add up.
  let offset = 0, joined = "";
  for (let guard = 0; guard < 10_000; guard++) {
    const page = host.read({ resultId: "00000000-0000-4000-8000-000000000001", invocationId: "1:t1", channel: "c", offset, length: 7 });
    expect(page.text).not.toContain("�");
    expect(page.totalBytes).toBe(total);
    joined += page.text; offset += Buffer.byteLength(page.text);
    if (page.eof) break;
  }
  expect(joined).toBe(serialized);
  for (const resultId of ["../results/00000000-0000-4000-8000-000000000001", "/etc/passwd", "", "00000000-0000-4000-8000-000000000001/.."])
    expect(await code(() => host.read({ resultId, invocationId: "1:t1", channel: "c", offset: 0, length: 10 }))).toBe("result_not_found");
  expect(await code(() => host.read({ resultId: "00000000-0000-4000-8000-000000000009", invocationId: "1:t1", channel: "c", offset: 0, length: 10 }))).toBe("result_expired");
  // Past its lifetime: reported expired and removed.
  const path = join(directory, "00000000-0000-4000-8000-000000000001"), old = new Date(Date.now() - 120_000);
  utimesSync(path, old, old);
  expect(await code(() => host.read({ resultId: "00000000-0000-4000-8000-000000000001", invocationId: "1:t1", channel: "c", offset: 0, length: 10 }))).toBe("result_expired");
  expect(existsSync(path)).toBe(false);
  // A directory the consumer chose is left in place.
  host.dispose();
  expect(existsSync(directory)).toBe(true);
});

test("a lower inline threshold counts the success envelope", async () => {
  const output = "€";
  const configuredLimit = Buffer.byteLength(JSON.stringify({ ok: true, output }));
  const config = {
    resultDirectory: temp(),
    tools: { example: { description: "", parameters: schema, handler: () => output } },
  };
  const signal = new AbortController().signal;
  const exact = createNativeFunctionHost({ ...config, inlineBytes: configuredLimit });
  const short = createNativeFunctionHost({ ...config, inlineBytes: configuredLimit - 1 });
  expect(await exact.call(call("example"), signal)).toEqual({ output });
  expect(await short.call(call("example"), signal)).toMatchObject({
    reference: { bytes: Buffer.byteLength(JSON.stringify(output)) },
  });
});

test("a backend that supervises its own turns runs under no host silence limit, even a configured one", () => {
  const limits = { firstOutputMs: 100, nextOutputMs: 100, toolMs: 100 };
  const native = { conversationCapabilities: { nativeSteering: true, backend: null, supervision: "backend" }, currentMode: undefined } as never;
  const ordinary = { conversationCapabilities: { nativeSteering: false, backend: null }, currentMode: "acp" } as never;
  expect(stallLimitsFor(native, limits)).toEqual({ firstOutputMs: false, nextOutputMs: false, toolMs: false });
  expect(stallLimitsFor(native, undefined)).toEqual({ firstOutputMs: false, nextOutputMs: false, toolMs: false });
  expect(stallLimitsFor(ordinary, limits)).toBe(limits);
});
