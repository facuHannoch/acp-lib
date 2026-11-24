import { describe, expect, test } from "bun:test";
import { AttachmentInputError, mixedPartsSignature, validateMixedParts } from "../src/capabilities/attachments/input.ts";

describe("mixed attachment input", () => {
  test("preserves order and boundaries in retry identity", () => {
    const a = validateMixedParts([{ type: "text", text: "one" }, { type: "attachment", id: "a" }, { type: "text", text: "two" }]);
    const b = validateMixedParts([{ type: "text", text: "one" }, { type: "text", text: "two" }, { type: "attachment", id: "a" }]);
    expect(mixedPartsSignature(a)).not.toBe(mixedPartsSignature(b));
    expect(mixedPartsSignature(a)).toBe(mixedPartsSignature(structuredClone(a)));
    expect(validateMixedParts([{ type: "attachment", id: "a" }])).toHaveLength(1);
  });
  test("enforces reference and encoded input limits", () => {
    expect(() => validateMixedParts(Array.from({ length: 9 }, () => ({ type: "attachment", id: "a" })))).toThrow(AttachmentInputError);
    expect(() => validateMixedParts([{ type: "attachment", id: "a" }, { type: "text", text: "x".repeat(8192) }])).toThrow(AttachmentInputError);
    expect(() => validateMixedParts([{ type: "attachment", id: "a", extra: true }])).toThrow(AttachmentInputError);
  });
});
