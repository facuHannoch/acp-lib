import { expect, test } from "bun:test";
import { resolveParts, type MediaStore, type StoredMedia } from "../src/media/store.ts";
import { persistParts, contentText } from "../src/media/content.ts";

export function memoryStore(): MediaStore {
  const values = new Map<string, StoredMedia & { data: Uint8Array }>();
  return {
    async put(data, info) { const ref = crypto.randomUUID(); values.set(ref, { ref, info, data: new Uint8Array(data) }); return ref; },
    async get(ref) { return values.get(ref) ?? null; },
    async list(owner) { return [...values.values()].filter((v) => v.info.owner === owner).map(({ ref, info }) => ({ ref, info })); },
    async delete(ref) { values.delete(ref); },
  };
}
const caps = { image: true, audio: true, embeddedContext: true };
test("copies are byte-free records; refs reuse within an owner and copy across owners", async () => {
  const store = memoryStore();
  const parts = await resolveParts([{ kind: "image", data: new Uint8Array([1, 2]), name: "plot.png", mimeType: "image/png" }], { cwd: ".", capabilities: caps });
  const content = await persistParts(parts, "a", store);
  expect(content).toMatchObject([{ type: "media", kind: "image", mode: "copy", name: "plot.png", size: 2 }]);
  expect(JSON.stringify(content)).not.toContain('"data"');
  const ref = (await store.list("a"))[0]!.ref;
  const reused = await resolveParts([{ kind: "image", ref }], { cwd: ".", capabilities: caps, store, owner: "a" });
  expect(await persistParts(reused, "a", store)).toMatchObject([{ ref }]);
  expect(await store.list("a")).toHaveLength(1);
  const copied = await resolveParts([{ kind: "image", ref }], { cwd: ".", capabilities: caps, store, owner: "b" });
  await persistParts(copied, "b", store);
  expect((await store.list("b"))[0]!.ref).not.toBe(ref);
  await store.delete(ref);
  await expect(resolveParts([{ kind: "image", ref }], { cwd: ".", capabilities: caps, store })).rejects.toThrow("missing or removed");
  expect(content).toMatchObject([{ ref }]);
});

test("keep and record policies control storage independently; pasted text is searchable", async () => {
  const parts = await resolveParts([
    { kind: "text", text: "recorded" }, { kind: "pasted", text: "paste", name: "notes" },
    { kind: "text", text: "secret", record: false },
    { kind: "file", data: new Uint8Array([1]), keep: false },
    { kind: "file", data: new Uint8Array([2]), record: false },
  ], { cwd: ".", capabilities: caps });
  const store = memoryStore();
  const content = await persistParts(parts, "a", store);
  expect(await store.list("a")).toHaveLength(0);
  expect(contentText(content)).toBe("recorded\npaste");
  expect(JSON.stringify(content)).not.toContain("secret");
  const explicit = await resolveParts([{ kind: "image", data: new Uint8Array([1]), keep: true }], { cwd: ".", capabilities: caps });
  await expect(persistParts(explicit, "a")).rejects.toThrow("requires a media store");
  expect(await persistParts(parts, "a")).toMatchObject([{ type: "text" }, { type: "pasted" }, { type: "media" }]);
});
