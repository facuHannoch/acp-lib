import { describe, expect, test } from "bun:test";
import type { AttachmentMetadata, InputPart } from "../src/contracts/attachments.ts";
import { mayReadAttachment, selectImageBudget } from "../src/capabilities/attachments/selection.ts";

const image = (id: string, bytes: number): AttachmentMetadata => ({ id, channel: "a", filename: "x", mediaType: "image/png", bytes, sha256: "0".repeat(64) });
const item = (...ids: string[]) => ({ parts: ids.map(id => ({ type: "attachment" as const, id })) as InputPart[] });
describe("attachment selection", () => {
  test("shares only after timeline publication", () => {
    expect(mayReadAttachment({ ownerChannel: "a", requestingChannel: "a", timelineVisible: false, timelineReadable: false })).toBe(true);
    expect(mayReadAttachment({ ownerChannel: "a", requestingChannel: "b", timelineVisible: false, timelineReadable: true })).toBe(false);
    expect(mayReadAttachment({ ownerChannel: "a", requestingChannel: "b", timelineVisible: true, timelineReadable: true })).toBe(true);
    expect(mayReadAttachment({ ownerChannel: "a", requestingChannel: "b", timelineVisible: true, timelineReadable: false })).toBe(false);
  });
  test("defers the FIFO head and counts active and repeated images", () => {
    const files = new Map([["a", image("a", 20 * 1024 * 1024)], ["b", image("b", 20 * 1024 * 1024)]]);
    const lookup = (id: string) => files.get(id);
    const result = selectImageBudget([item("a")], [item("b", "b"), item("a")], lookup);
    expect(result.selected).toEqual([]); expect(result.deferred).toBe(true);
    expect(selectImageBudget([], [item("b", "b"), item("a")], lookup).selected).toHaveLength(1);
    expect(selectImageBudget([], [item("missing")], lookup).unavailable).toEqual(["missing"]);
  });
});
