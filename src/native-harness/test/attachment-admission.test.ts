import { expect, test } from "bun:test";
import { admitAttachmentInput } from "../src/capabilities/attachments/admission.ts";
const parts = [{ type: "text", text: "hello" }, { type: "attachment", id: "image" }];
const metadata = { id: "image", channel: "a", filename: "image.png", mediaType: "image/png", bytes: 1, sha256: "0".repeat(64) };
test("acceptance associates ordered references, and a duplicate bypasses changed capability and availability", () => {
  let identity = "", associated = false;
  const callbacks = { channel: "a", identity: "sender and policy", content: parts, imageInput: true,
    known: () => undefined, lookup: () => metadata,
    accept: (value: string) => { identity = value; return "item"; },
    associate: (_value: string) => { associated = true; } };
  expect(admitAttachmentInput(callbacks)).toEqual({ value: "item", duplicate: false });
  expect(associated).toBe(true);
  expect(admitAttachmentInput({ ...callbacks, imageInput: false, lookup: () => undefined,
    known: () => ({ identity, value: "item" }), accept: () => { throw Error("unexpected acceptance"); } }))
    .toEqual({ value: "item", duplicate: true });
  expect(() => admitAttachmentInput({ ...callbacks, content: [...parts, { type: "text", text: "changed" }],
    known: () => ({ identity, value: "item" }) })).toThrow("different input");
});
test("rejects wrong-channel references before acceptance", () => {
  expect(() => admitAttachmentInput({ channel: "b", identity: "identity", content: parts, imageInput: true,
    known: () => undefined, lookup: () => metadata, accept: () => { throw Error("must not accept"); }, associate: () => {} }))
    .toThrow("Unknown attachment");
});
