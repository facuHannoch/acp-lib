import { describe, expect, test } from "bun:test";
import {
  formatResponseMessages,
  joinResponseMessages,
  ResponseAccumulator,
} from "../src/response.ts";

describe("response text projection", () => {
  test("one message remains byte-for-byte unchanged", () => {
    expect(joinResponseMessages([{ text: " one\n" }])).toBe(" one\n");
  });

  test("separates messages but not token chunks within one message", () => {
    const response = new ResponseAccumulator();
    response.append({ messageId: "m1", text: "first " });
    response.append({ messageId: "m1", text: "message" });
    response.append({ messageId: "m2", text: "second" });

    expect(response.snapshot()).toEqual([
      { messageId: "m1", text: "first message" },
      { messageId: "m2", text: "second" },
    ]);
    expect(response.text).toBe("first message\n\nsecond");
  });

  test("a closed message ends even without message ids; closing before any text does nothing", () => {
    const response = new ResponseAccumulator();
    response.closeMessage();
    expect(response.append({ text: "before" }).startsMessage).toBe(true);
    response.append({ text: " tool" });
    response.closeMessage();
    expect(response.append({ text: "after" }).startsMessage).toBe(true);
    expect(response.append({ text: " tool" }).startsMessage).toBe(false);

    expect(response.snapshot()).toEqual([{ text: "before tool" }, { text: "after tool" }]);
  });

  test("empty entries participate in the documented literal join", () => {
    expect(joinResponseMessages([{ text: "first" }, { text: "" }, { text: "third" }]))
      .toBe("first\n\n\n\nthird");
  });

  test("consumer formatting makes the flattening policy explicit", () => {
    const messages = [{ text: "first" }, { text: "second" }];
    expect(formatResponseMessages(messages, " | ")).toBe("first | second");
    expect(formatResponseMessages(messages, "")).toBe("firstsecond");
    expect(() => formatResponseMessages(messages, null as never)).toThrow(TypeError);
  });
});
