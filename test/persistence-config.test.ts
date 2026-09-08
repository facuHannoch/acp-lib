import { describe, expect, test } from "bun:test";
import {
  DEFAULT_AUDIT_LOG_CAPTURE,
  DEFAULT_PERSISTENCE_LIMITS,
  PersistenceConfigurationError,
  TRANSCRIPT_PRESETS,
  resolveDirectPersistence,
  resolveManagedPersistence,
  resolvePersistenceRoot,
} from "../src/persistence/config.ts";

const ROOT_ENV = {
  env: {},
  home: "/home/tester",
  cwd: "/work/project",
} as const;

describe("persistence configuration", () => {
  test("direct sessions default to no persistence", () => {
    expect(resolveDirectPersistence(undefined, ROOT_ENV)).toBe(false);
    expect(resolveDirectPersistence(false, ROOT_ENV)).toBe(false);
  });

  test("explicit direct persistence starts from the managed activity defaults", () => {
    expect(resolveDirectPersistence({}, ROOT_ENV)).toEqual({
      root: "/home/tester/.acp-client",
      transcript: {
        preset: "activity",
        capture: TRANSCRIPT_PRESETS.activity,
        includeTruncationDigests: false,
      },
      auditLog: false,
      sessionConfiguration: { values: "typed", include: [], exclude: [] },
      limits: DEFAULT_PERSISTENCE_LIMITS,
    });
  });

  test("all transcript presets expand to the specified complete policies", () => {
    for (const preset of ["conversation", "activity", "detailed", "diagnostic"] as const) {
      const resolved = resolveDirectPersistence({ transcript: { preset } }, ROOT_ENV);
      expect(resolved).not.toBe(false);
      if (resolved === false) throw new Error("unreachable");
      expect(resolved.transcript).not.toBe(false);
      if (resolved.transcript === false) throw new Error("unreachable");
      expect(resolved.transcript.preset).toBe(preset);
      expect(resolved.transcript.capture).toEqual(TRANSCRIPT_PRESETS[preset]);
    }
  });

  test("a preset resets inherited capture before same-layer overrides", () => {
    const resolved = resolveManagedPersistence(
      "/catalog",
      {
        transcript: {
          preset: "detailed",
          capture: { messages: "none", protocol: "metadata" },
        },
      },
      {
        transcript: {
          preset: "conversation",
          capture: { tools: "metadata" },
        },
      },
      {},
      ROOT_ENV,
    );

    expect(resolved.transcript).toEqual({
      preset: "conversation",
      capture: { ...TRANSCRIPT_PRESETS.conversation, tools: "metadata" },
      includeTruncationDigests: false,
    });
  });

  test("member overrides inherit when no new preset is supplied", () => {
    const resolved = resolveManagedPersistence(
      "/catalog",
      { transcript: { preset: "detailed", capture: { messages: "none" } } },
      { transcript: { capture: { protocol: "metadata" } } },
      {},
      ROOT_ENV,
    );
    if (resolved.transcript === false) throw new Error("unreachable");

    expect(resolved.transcript.capture).toEqual({
      ...TRANSCRIPT_PRESETS.detailed,
      messages: "none",
      protocol: "metadata",
    });
  });

  test("a higher object re-enables a lower disabled log from library defaults", () => {
    const resolved = resolveManagedPersistence(
      "/catalog",
      { transcript: false, auditLog: false },
      {
        transcript: { capture: { messages: "none" } },
        auditLog: { capture: { reasoning: "text" } },
      },
      {},
      ROOT_ENV,
    );

    expect(resolved.transcript).toEqual({
      preset: "activity",
      capture: { ...TRANSCRIPT_PRESETS.activity, messages: "none" },
      includeTruncationDigests: false,
    });
    expect(resolved.auditLog).toEqual({
      capture: { ...DEFAULT_AUDIT_LOG_CAPTURE, reasoning: "text" },
      includeTruncationDigests: false,
    });
  });

  test("the highest false remains final", () => {
    const resolved = resolveManagedPersistence(
      "/catalog",
      { transcript: { preset: "diagnostic" }, auditLog: {} },
      { transcript: false, auditLog: false },
      {},
      ROOT_ENV,
    );
    expect(resolved.transcript).toBe(false);
    expect(resolved.auditLog).toBe(false);
  });

  test("session configuration arrays replace instead of concatenate", () => {
    const resolved = resolveManagedPersistence(
      "/catalog",
      { sessionConfiguration: { values: "all", include: ["model"], exclude: ["secret"] } },
      { sessionConfiguration: { include: ["reasoning"] } },
      {},
      ROOT_ENV,
    );
    expect(resolved.sessionConfiguration).toEqual({
      values: "all",
      include: ["reasoning"],
      exclude: ["secret"],
    });
  });

  test("limits merge and enforce the hard ranges", () => {
    const resolved = resolveManagedPersistence(
      "/catalog",
      { limits: { maxRecordBytes: 2_000_000 } },
      { limits: { maxCapturedFieldBytes: 1_000_000 } },
      {},
      ROOT_ENV,
    );
    expect(resolved.limits).toEqual({
      ...DEFAULT_PERSISTENCE_LIMITS,
      maxRecordBytes: 2_000_000,
      maxCapturedFieldBytes: 1_000_000,
    });

    expect(() =>
      resolveManagedPersistence(
        "/catalog",
        undefined,
        { limits: { maxRecordBytes: 4_096, maxCapturedFieldBytes: 4_097 } },
        {},
        ROOT_ENV,
      ),
    ).toThrow(PersistenceConfigurationError);
  });

  test("constraints validate without silently modifying resolved logs", () => {
    expect(() =>
      resolveManagedPersistence(
        "/catalog",
        undefined,
        { transcript: false },
        { transcript: "required" },
        ROOT_ENV,
      ),
    ).toThrow("transcript persistence is required");

    expect(() =>
      resolveManagedPersistence(
        "/catalog",
        undefined,
        { auditLog: {} },
        { auditLog: "forbidden" },
        ROOT_ENV,
      ),
    ).toThrow("audit log persistence is forbidden");
  });

  test("runtime callers cannot smuggle unknown fields into persisted policy", () => {
    expect(() =>
      resolveDirectPersistence(
        {
          transcript: {
            capture: { messages: "text", secretValue: "do not persist" } as never,
          },
        },
        ROOT_ENV,
      ),
    ).toThrow("transcript.capture.secretValue is not supported");

    expect(() =>
      resolveDirectPersistence(
        { limits: { maxRecordBytes: 10_000, extra: "do not persist" } as never },
        ROOT_ENV,
      ),
    ).toThrow("limits.extra is not supported");

    expect(() =>
      resolveManagedPersistence(
        "/catalog",
        { root: "/split-catalog" } as never,
        undefined,
        {},
        ROOT_ENV,
      ),
    ).toThrow("sessionDefaults.root is not supported");
  });

  test("root precedence is explicit, environment, then home default", () => {
    expect(resolvePersistenceRoot("relative/root", ROOT_ENV)).toBe("/work/project/relative/root");
    expect(resolvePersistenceRoot(undefined, { ...ROOT_ENV, env: { ACP_CLIENT_HOME: "/env/root" } }))
      .toBe("/env/root");
    expect(resolvePersistenceRoot(undefined, ROOT_ENV)).toBe("/home/tester/.acp-client");
    expect(resolvePersistenceRoot("~/custom", ROOT_ENV)).toBe("/home/tester/custom");
  });

  test("resolved policies are detached from mutable input", () => {
    const include = ["model"];
    const capture = { messages: "none" as const };
    const resolved = resolveDirectPersistence(
      { transcript: { capture }, sessionConfiguration: { include } },
      ROOT_ENV,
    );
    if (resolved === false || resolved.transcript === false) throw new Error("unreachable");

    include.push("reasoning");
    capture.messages = "text";
    expect(resolved.sessionConfiguration.include).toEqual(["model"]);
    expect(resolved.transcript.capture.messages).toBe("none");
    expect(Object.isFrozen(resolved.transcript.capture)).toBe(true);
    expect(Object.isFrozen(resolved.sessionConfiguration.include)).toBe(true);
  });
});
