import { describe, expect, test } from "bun:test";
import { extractReply } from "../src/degraded/extract.ts";

describe("degraded reply extraction", () => {
  test("extracts text after the latest echoed prompt", () => {
    expect(
      extractReply(
        [
          "old content",
          "› Explain ACP",
          "• ACP is a protocol.",
          "  It connects clients and agents.",
          "› ",
        ],
        "Explain ACP",
      ),
    ).toBe("ACP is a protocol.\n  It connects clients and agents.");
  });

  test("falls back to lines added after the pre-prompt screen", () => {
    expect(
      extractReply(
        ["Agent banner", "• New answer", "model medium · ~/work"],
        "a wrapped prompt that cannot be found",
        ["Agent banner"],
      ),
    ).toBe("New answer");
  });
});
