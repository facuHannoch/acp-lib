import { describe, expect, test } from "bun:test";
import {
  parseBoolean,
  parseConfigValue,
  parseJsonOrString,
} from "../src/controller.ts";
import { parseConfigOptions } from "../src/config-options.ts";

describe("configuration parsing", () => {
  test("normalizes nested select options", () => {
    const options = parseConfigOptions([
      {
        id: "model",
        name: "Model",
        type: "select",
        currentValue: "fast",
        options: [
          {
            group: "Models",
            options: [
              { value: "fast", name: "Fast" },
              { value: "smart", name: "Smart" },
            ],
          },
        ],
      },
    ] as never);

    expect(options.get("model")).toEqual({
      configId: "model",
      label: "Model",
      description: undefined,
      type: "select",
      currentValue: "fast",
      allowedValues: [
        { value: "fast", label: "Fast", description: undefined },
        { value: "smart", label: "Smart", description: undefined },
      ],
    });
  });

  test("validates select values", () => {
    const option = {
      configId: "effort",
      type: "select" as const,
      currentValue: "low",
      allowedValues: [{ value: "low" }, { value: "high" }],
    };

    expect(parseConfigValue(option, "high")).toEqual({ ok: true, value: "high" });
    expect(parseConfigValue(option, "invalid")).toEqual({
      ok: false,
      error: 'invalid value "invalid" for effort; allowed: low, high',
    });
  });

  test("parses common boolean and JSON values", () => {
    expect(parseBoolean("YES")).toBe(true);
    expect(parseBoolean("off")).toBe(false);
    expect(parseBoolean("sometimes")).toBeNull();
    expect(parseJsonOrString('{"depth":2}')).toEqual({ depth: 2 });
    expect(parseJsonOrString("plain text")).toBe("plain text");
  });
});
