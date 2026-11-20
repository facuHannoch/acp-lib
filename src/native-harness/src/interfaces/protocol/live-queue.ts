import { MAX_FRAME_BYTES } from "./framing.ts";

/** The queue sits before the existing writer. Producers never await a reader;
 * only deltas may be dropped, and the gap travels before completion. */
export class LiveQueue {
  private queue: { message: any; bytes: number }[] = [];
  private bytes = 0;
  private running = false;
  private failed: unknown;
  private idle: (() => void)[] = [];
  private dropped = new Set<string>();
  constructor(private readonly write: (message: unknown) => Promise<void>, private readonly fail: (error: unknown) => void, private readonly limit = MAX_FRAME_BYTES) {}
  private size(message: unknown) { return new TextEncoder().encode(JSON.stringify(message)).length + 1; }
  private push(message: any) {
    const bytes = this.size(message);
    if (this.bytes + bytes > this.limit) throw new Error("Protocol live queue exceeds buffer limit");
    this.queue.push({ message, bytes }); this.bytes += bytes;
  }
  send(value: unknown): void {
    if (this.failed) throw this.failed;
    const message = structuredClone(value) as any, event = message?.method === "channel/event" ? message.params?.event : undefined;
    const key = event?.messageId && `${message.params.channel}\u0000${event.turnId}\u0000${event.messageId}`;
    if (event?.type === "text_delta" && key) {
      if (this.dropped.has(key)) return;
      const last = this.queue.at(-1), previous = last?.message?.params?.event;
      if (last && previous?.type === "text_delta" && last.message.params.channel === message.params.channel && previous.turnId === event.turnId && previous.messageId === event.messageId) {
        const merged = structuredClone(last.message); merged.params.event.text += event.text;
        const bytes = this.size(merged);
        if (this.bytes - last.bytes + bytes <= this.limit) { this.bytes += bytes - last.bytes; last.message = merged; last.bytes = bytes; return; }
      }
      if (this.bytes + this.size(message) > this.limit) {
        this.dropped.add(key);
        this.push({ ...message, params: { ...message.params, event: { type: "text_gap", turnId: event.turnId, messageId: event.messageId } } });
        this.drain(); return;
      }
    }
    this.push(message);
    if (key && (event?.type === "message_completed" || event?.type === "text_incomplete")) this.dropped.delete(key);
    this.drain();
  }
  private drain() {
    if (this.running || this.failed) return;
    this.running = true;
    void (async () => {
      try {
        while (this.queue.length) {
          const item = this.queue.shift()!;
          await this.write(item.message); this.bytes -= item.bytes;
        }
      } catch (error) { this.failed = error; this.fail(error); }
      finally { this.running = false; for (const resolve of this.idle.splice(0)) resolve(); }
    })();
  }
  async flush() { while (this.running) await new Promise<void>(resolve => this.idle.push(resolve)); if (this.failed) throw this.failed; }
}
