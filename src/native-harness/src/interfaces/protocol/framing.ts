export const MAX_FRAME_BYTES = 1024 * 1024;

/** Buffer bytes, not strings: a UTF-8 character can span input chunks. */
export class LineDecoder {
  private parts: Uint8Array[] = [];
  private size = 0;
  constructor(private readonly limit = MAX_FRAME_BYTES) {}
  push(chunk: Uint8Array): string[] {
    const lines: string[] = [];
    let start = 0;
    for (let i = 0; i <= chunk.length; i++) {
      if (i !== chunk.length && chunk[i] !== 10) continue;
      const part = chunk.slice(start, i);
      this.size += part.length;
      if (this.size > this.limit) throw new Error("Protocol frame exceeds size limit");
      if (part.length) this.parts.push(part);
      if (i < chunk.length) {
        const bytes = new Uint8Array(this.size);
        let offset = 0;
        for (const item of this.parts) { bytes.set(item, offset); offset += item.length; }
        const line = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/\r$/, "");
        this.parts = []; this.size = 0;
        if (line.trim()) lines.push(line);
      }
      start = i + 1;
    }
    return lines;
  }
  finish() { if (this.size) throw new Error("Incomplete protocol frame at EOF"); }
}

/** One ordered writer for responses and notifications, with bounded buffering. */
export class LineWriter {
  private tail: Promise<void> = Promise.resolve();
  private queued = 0;
  constructor(private readonly write: (bytes: Uint8Array) => Promise<void>) {}
  send(message: unknown): Promise<void> {
    const bytes = new TextEncoder().encode(`${JSON.stringify(message)}\n`);
    if (bytes.length - 1 > MAX_FRAME_BYTES || this.queued + bytes.length > 4 * MAX_FRAME_BYTES) throw new Error("Protocol output exceeds buffer limit");
    this.queued += bytes.length;
    const next = this.tail.then(() => this.write(bytes)).finally(() => { this.queued -= bytes.length; });
    this.tail = next;
    void next.catch(() => {});
    return next;
  }
  flush() { return this.tail; }
}
