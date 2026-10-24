import { expect, test } from "bun:test";
import { contentText } from "../src/media/content.ts";

test("structured content projects text without indexing image bytes", () => {
  expect(contentText("plain")).toBe("plain");
  expect(contentText([
    { type: "text", text: "hello" },
    { type: "image", mimeType: "image/png", data: "secret-base64", alt: "chart" },
    { type: "resource", uri: "file:///report", text: "report" },
  ])).toBe("hello\nchart\nreport\nfile:///report");
});
