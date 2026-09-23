import { describe, expect, test } from "bun:test";
import { AgentConversationQueue } from "../src/agent-conversation-queue.ts";

describe("AgentConversationQueue", () => {
  test("executes queued work in FIFO order without overlap", async () => {
    const queue = new AgentConversationQueue<number>();
    const order: string[] = [];
    let active = 0;
    let maximumActive = 0;

    queue.enqueue(1);
    queue.enqueue(2);
    await queue.drain(async (item) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      order.push(`start:${item}`);
      await Promise.resolve();
      order.push(`end:${item}`);
      active -= 1;
    });

    expect(order).toEqual(["start:1", "end:1", "start:2", "end:2"]);
    expect(maximumActive).toBe(1);
    expect(queue.queuedCount).toBe(0);
    expect(queue.isDraining).toBe(false);
  });

  test("an active drain consumes work enqueued by an operation", async () => {
    const queue = new AgentConversationQueue<number>();
    const seen: number[] = [];
    queue.enqueue(1);

    await queue.drain(async (item) => {
      seen.push(item);
      if (item === 1) queue.enqueue(2);
    });

    expect(seen).toEqual([1, 2]);
  });

  test("concurrent drain attempts do not start another executor", async () => {
    const queue = new AgentConversationQueue<number>();
    const seen: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    queue.enqueue(1);
    queue.enqueue(2);

    const first = queue.drain(async (item) => {
      seen.push(item);
      if (item === 1) await gate;
    });
    const second = queue.drain(async () => {
      throw new Error("a second executor must not run");
    });

    expect(second).toBe(first);
    expect(queue.waitForIdle()).toBe(first);
    expect(queue.isDraining).toBe(true);
    expect(queue.queuedCount).toBe(1);
    release();
    await Promise.all([first, second]);
    expect(seen).toEqual([1, 2]);
    await queue.waitForIdle();
  });

  test("clear removes only work which has not started", async () => {
    const queue = new AgentConversationQueue<number>();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    queue.enqueue(1);
    queue.enqueue(2);
    queue.enqueue(3);

    const draining = queue.drain(async (item) => {
      if (item === 1) await gate;
    });
    expect(queue.clear()).toEqual([2, 3]);
    expect(queue.queuedCount).toBe(0);
    release();
    await draining;
  });
});
