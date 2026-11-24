import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recoverAttachmentOrphans } from "../src/capabilities/attachments/recovery.ts";

test("owner recovery removes only staging and published bytes without metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "attachment-recovery-"));
  const kept = "11111111-1111-4111-8111-111111111111", orphan = "22222222-2222-4222-8222-222222222222", stage = ".stage-33333333-3333-4333-8333-333333333333";
  try {
    for (const name of [kept, orphan, stage, "other"]) writeFileSync(join(root, name), "bytes");
    expect(recoverAttachmentOrphans(root, new Set([kept])).removed).toEqual([stage, orphan]);
    expect(readFileSync(join(root, kept), "utf8")).toBe("bytes");
    expect(readFileSync(join(root, "other"), "utf8")).toBe("bytes");
    expect(recoverAttachmentOrphans(root, new Set([kept])).removed).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
