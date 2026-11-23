import { expect, test } from "bun:test";
import type { ChannelEvent } from "../../src/native-harness/src/client.ts";
import { spawnHarness } from "../../src/native-harness/test/helpers/stdio.ts";
import type { ResponseChunk } from "../../src/types.ts";
import { hold, nativeRig, reply } from "./support.ts";

function holdFirstCompletion(rig: Awaited<ReturnType<typeof nativeRig>>) {
  const boundary = Promise.withResolvers<void>();
  const buffered: ChannelEvent[] = [];
  let release: () => void = () => {};
  let deltasBeforeCompletion = 0;
  rig.harness.connect = async () => {
    const child = spawnHarness({ home: rig.home, effects: rig.effectsPath });
    // Hold the ordered completion frame and later events without delaying earlier text.
    const subscribe = child.client.onChannelEvent.bind(child.client);
    child.client.onChannelEvent = listener => {
      let blocking = false;
      let released = false;
      release = () => {
        released = true;
        for (const event of buffered.splice(0)) listener(event);
      };
      return subscribe(event => {
        if (!blocking && !released && event.event.type === "text_delta") deltasBeforeCompletion++;
        if (event.event.type === "message_completed" && !released) {
          blocking = true;
          boundary.resolve();
        }
        if (blocking && !released) buffered.push(event);
        else listener(event);
      });
    };
    return { client: child.client, closed: child.child.exited.then(() => undefined), kill: () => child.close() };
  };
  return { reached: boundary.promise, release: () => release(), get deltaCount() { return deltasBeforeCompletion; } };
}

for (const mode of ["stream", "default final"] as const) {
  test(`native ${mode} text reaches the conversation over real stdio`, async () => {
    const rig = await nativeRig();
    const completedOnWire = holdFirstCompletion(rig);
    const tool = Promise.withResolvers<void>();
    const liveText = Promise.withResolvers<void>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const working = hold("stream-boundary", "Working");
      rig.script([{ ...working, chunks: [{ afterMs: 0, text: "Work" }, { afterMs: 0, text: "ing" }] }, reply("Finished.")]);
      if (mode === "stream") rig.harness.text = "stream";
      const agent = await rig.open();
      const conversation = await agent.conversations.create();
      const chunks: ResponseChunk[] = [];
      const raw: string[] = [];
      let settled = false;
      const run = conversation.prompt("stream through the public conversation", {
        onChunk: text => raw.push(text),
        onResponseChunk(chunk) {
          chunks.push(chunk);
          if (chunks.map(delta => delta.text).join("") === "Working") liveText.resolve();
        },
        onActivity(event) {
          if (event.kind === "tool" && event.toolCallId === "hold-stream-boundary") tool.resolve();
        },
      });
      void run.then(() => { settled = true; }, () => { settled = true; });
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("the conversation did not reach the stream boundary")), 15_000);
      });
      await Promise.race([completedOnWire.reached, deadline, run]);
      if (mode === "stream") {
        await Promise.race([liveText.promise, deadline, run]);
        expect(completedOnWire.deltaCount).toBeGreaterThan(0);
        expect(raw.join("")).toBe("Working");
      } else {
        expect(completedOnWire.deltaCount).toBe(0);
        expect(raw).toEqual([]);
      }
      expect(settled).toBe(false);

      completedOnWire.release();
      await Promise.race([tool.promise, deadline, run]);
      expect(settled).toBe(false);
      expect(raw.join("")).toBe("Working");
      const firstId = chunks[0]?.messageId;
      expect(firstId).toEqual(expect.any(String));
      expect(new Set(chunks.map(chunk => chunk.messageId))).toEqual(new Set([firstId]));
      expect(chunks.filter(chunk => chunk.startsMessage)).toHaveLength(1);

      rig.release("stream-boundary");
      const result = await Promise.race([run, deadline]);
      expect(result.status).toBe("completed");
      expect(result.text).toBe("Working\n\nFinished.");
      expect(result.messages.map(message => message.text)).toEqual(["Working", "Finished."]);
      expect(result.messages[0]?.messageId).toBe(firstId);
      expect(raw.join("")).toBe("WorkingFinished.");

      const { records } = await agent.persistence.records.list(conversation.id);
      const replies = records.filter(record => record.kind === "message" && record.role === "assistant");
      // Activity can write a completed snapshot before the normal final commit. Those
      // revisions share a logical ID. The unsuffixed commit is the authoritative one.
      const finals = replies.filter(record => !record.recordId.includes(":snapshot:"));
      expect(finals.map(record => record.content)).toEqual(["Working", "Finished."]);
      expect(finals.every(record => record.status === "completed")).toBe(true);
      expect(new Set(replies.map(record => record.logicalMessageId))).toEqual(new Set(finals.map(record => record.logicalMessageId)));
      expect(finals.map(record => JSON.parse(record.metadata!).providerMessageId)).toEqual(result.messages.map(message => message.messageId));
    } finally {
      clearTimeout(timer);
      completedOnWire.release();
      rig.release("stream-boundary");
      await rig.clean();
    }
  }, 30_000);
}
