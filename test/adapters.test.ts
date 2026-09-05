import { describe, expect, test } from "bun:test";
import { ADAPTERS, buildPtyCommand, buildSpawnCommand } from "../src/adapters.ts";

test("Pi preset launches pi-acp and degrades to the native Pi CLI", () => {
  expect(ADAPTERS.pi).toEqual({ command: ["pi-acp"], ptyCommand: ["pi"], displayName: "Pi" });
  expect(buildSpawnCommand(ADAPTERS.pi, ["docker", "exec", "-i", "agent"])).toEqual([
    "docker", "exec", "-i", "agent", "pi-acp",
  ]);
  expect(buildPtyCommand(ADAPTERS.pi)).toEqual(["pi"]);
});

describe("adapter commands", () => {
  test("prepends an execution prefix to an ACP command", () => {
    expect(
      buildSpawnCommand(
        { command: ["agent", "--acp"] },
        ["docker", "exec", "-i", "sandbox"],
      ),
    ).toEqual(["docker", "exec", "-i", "sandbox", "agent", "--acp"]);
  });

  test("uses the interactive command in degraded mode", () => {
    expect(
      buildPtyCommand(
        { command: ["agent", "--acp"], ptyCommand: ["agent"] },
        ["docker", "exec", "-i", "sandbox"],
      ),
    ).toEqual(["docker", "exec", "-i", "sandbox", "agent"]);
  });

  test("rejects degraded mode when no interactive command exists", () => {
    expect(() => buildPtyCommand({ command: ["agent", "--acp"] })).toThrow(
      "adapter has no ptyCommand",
    );
  });
});
