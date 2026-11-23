import { expect, test } from "bun:test";
import { formatReply } from "../src/interfaces/cli/format-reply.ts";

test("terminal prose renders emphasis and bullets while fenced code retains literal markers", () => {
  const text = formatReply('**Exercise status:** `completed`\n- **Done**\n\n```ts\nconst pattern = "**literal**";\n```', false);
  expect(text).toContain("Exercise status: completed\n• Done");
  expect(text).toContain('const pattern = "**literal**";');
  expect(text).not.toContain("```");
  expect(formatReply("**Done**", true)).toBe("\x1b[1mDone\x1b[0m");
});
