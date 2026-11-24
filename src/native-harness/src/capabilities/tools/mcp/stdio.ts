// Runner-owned streams implement the SDK transport interface without giving
// the SDK authority to launch or inherit the harness environment.
export interface McpStdioProcess {
  stdout: ReadableStream<Uint8Array>;
  write(frame: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

const frameLimit = 256 * 1024;

export class McpStdioTransport<Message> {
  onmessage?: (message: Message) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;
  #started = false;
  #closing?: Promise<void>;
  #sends = Promise.resolve();
  readonly #process: McpStdioProcess;

  constructor(process: McpStdioProcess) {
    this.#process = process;
  }

  async start(): Promise<void> {
    if (this.#started || this.#closing) throw new Error("MCP transport already started or closed");
    this.#started = true;
    void this.#receive();
  }

  async #receive() {
    const reader = this.#process.stdout.getReader();
    const frame = new Uint8Array(frameLimit);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let size = 0;
    try {
      while (!this.#closing) {
        const read = await reader.read();
        if (read.done) {
          if (size) throw new Error("Incomplete MCP frame");
          break;
        }
        const chunk = read.value;
        for (let start = 0; start < chunk.length;) {
          const newline = chunk.indexOf(10, start);
          const end = newline < 0 ? chunk.length : newline;
          const length = end - start;
          if (size + length > frameLimit) throw new Error("MCP frame too large");
          frame.set(chunk.subarray(start, end), size);
          size += length;
          if (newline >= 0) {
            const message: unknown = JSON.parse(decoder.decode(frame.subarray(0, size)));
            if (!message || typeof message !== "object" || Array.isArray(message)) {
              throw new Error("Invalid MCP message");
            }
            this.onmessage?.(message as Message);
            size = 0;
          }
          start = end + 1;
        }
      }
    } catch {
      if (!this.#closing) this.onerror?.(new Error("Invalid MCP stdio stream"));
    } finally {
      reader.releaseLock();
      await this.close().catch(() => this.onerror?.(new Error("MCP stdio cleanup failed")));
    }
  }

  send(message: Message): Promise<void> {
    const frame = new TextEncoder().encode(JSON.stringify(message) + "\n");
    if (frame.length > frameLimit + 1) return Promise.reject(new Error("MCP frame too large"));
    const write = this.#sends.then(async () => {
      if (!this.#started || this.#closing) throw new Error("MCP transport is closed");
      await this.#process.write(frame);
    });
    this.#sends = write.catch(() => {});
    return write;
  }

  close(): Promise<void> {
    return this.#closing ??= Promise.resolve().then(async () => {
      try {
        await this.#process.close();
      } finally {
        this.onclose?.();
      }
    });
  }
}
