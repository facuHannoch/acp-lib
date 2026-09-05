import { describe, expect, test } from "bun:test";
import { parseCommandArg, resolveCliAdapter } from "../src/cli/adapter.ts";

describe("CLI adapter resolution", () => {
  test("resolves the Pi convenience preset", () => {
    expect(resolveCliAdapter({ adapterId: "pi" })).toEqual({
      adapterId: "pi",
      adapter: {
        command: ["pi-acp"],
        ptyCommand: ["pi"],
        displayName: "Pi",
      },
    });
  });

  test("defaults to the existing Kimi preset", () => {
    expect(resolveCliAdapter({}).adapterId).toBe("kimi");
  });

  test("constructs a custom adapter without consulting the preset table", () => {
    expect(resolveCliAdapter({
      adapterId: "private-agent",
      command: ["private-agent", "serve", "--acp"],
      ptyCommand: ["private-agent", "chat"],
      displayName: "Private Agent",
    })).toEqual({
      adapterId: "private-agent",
      adapter: {
        command: ["private-agent", "serve", "--acp"],
        ptyCommand: ["private-agent", "chat"],
        displayName: "Private Agent",
      },
    });
  });

  test("derives a useful id when a custom command omits one", () => {
    expect(resolveCliAdapter({ command: ["/opt/agents/private-acp"] }).adapterId)
      .toBe("private-acp");
  });

  test("rejects an unknown preset with custom-adapter guidance", () => {
    expect(() => resolveCliAdapter({ adapterId: "private-agent" }))
      .toThrow("use --adapter-command");
  });
});

describe("custom adapter command parsing", () => {
  test("accepts a plain executable", () => {
    expect(parseCommandArg("private-acp", "--adapter-command")).toEqual(["private-acp"]);
  });

  test("accepts exact JSON argv including spaces", () => {
    expect(parseCommandArg(
      '["/path with spaces/agent", "serve", "--mode=acp"]',
      "--adapter-command",
    )).toEqual(["/path with spaces/agent", "serve", "--mode=acp"]);
  });

  test("rejects malformed or empty argv", () => {
    expect(() => parseCommandArg("[oops", "--adapter-command")).toThrow("valid JSON");
    expect(() => parseCommandArg("[]", "--adapter-command")).toThrow("non-empty JSON array");
    expect(() => parseCommandArg(undefined, "--adapter-command")).toThrow("requires");
  });
});
