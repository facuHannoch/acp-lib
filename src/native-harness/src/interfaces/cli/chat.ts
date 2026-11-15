import { createInterface, clearLine, cursorTo } from "node:readline";
import { once } from "node:events";
import { localConnection } from "../../runtime/config/development.ts";
import { sendLocal } from "../protocol/local.ts";
import { subscribeLocal } from "../protocol/subscribe.ts";
import { formatReply } from "./format-reply.ts";

export async function chat(channelId: string, participantId: string) {
  const { socketPath } = localConnection();
  let terminal: ReturnType<typeof createInterface> | undefined;
  let pending = 0;
  let frame = 0;
  let spinner: ReturnType<typeof setInterval> | undefined;
  const drawPrompt = () => {
    if (!terminal || !process.stdout.isTTY) return;
    const draft = terminal.line;
    const cursor = terminal.cursor;
    const suffix = pending ? `  ${['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'][frame++ % 10]} working` : '';
    clearLine(process.stdout, 0); cursorTo(process.stdout, 0);
    process.stdout.write(`> ${draft}${suffix}`);
    const back = draft.length - cursor + suffix.length;
    if (back > 0) process.stdout.write(`\x1b[${back}D`);
  };
  const print = (text: string) => {
    if (terminal && process.stdout.isTTY) {
      clearLine(process.stdout, 0);
      cursorTo(process.stdout, 0);
    }
    console.log(`\n${text}\n`);
    // Redraw the current draft after unsolicited output instead of consuming it.
    if (terminal && process.stdout.isTTY) {
      // Redraw without writing the draft back into readline: it still owns the
      // original input buffer, and terminal.write would duplicate those bytes.
      drawPrompt();
    } else terminal?.prompt();
  };
  const subscription = await subscribeLocal(socketPath, channelId, output => {
    print(output.type === "error" ? output.text : formatReply(output.text));
  });
  terminal = createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
  const closed = once(terminal, "close");
  const requests = new AbortController();
  let closing = false;
  terminal.once("close", () => { closing = true; clearInterval(spinner); requests.abort(); subscription.close(); });
  void subscription.done.catch(error => {
    if (closing) return;
    print(`${String(error)}. Reconnect with bun run chat ${channelId} ${participantId}.`);
    terminal?.close();
  });
  console.log(`Channel ${channelId}, participant ${participantId}. /clear clears the screen; /exit disconnects.`);
  terminal.on("line", text => {
    const command = text.trim();
    if (command === "/exit") { terminal?.close(); return; }
    if (command === "/clear") {
      // Purely local: neither channel state nor its output subscription changes.
      if (process.stdout.isTTY) process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
    } else if (command) {
      pending++;
      if (process.stdout.isTTY && !spinner) spinner = setInterval(drawPrompt, 100);
      // Reply text comes only from the subscription, including this request's
      // answer, so HTTP acknowledgements cannot print it a second time.
      void sendLocal(socketPath, { channelId, participantId, text }, requests.signal).catch(error => {
        if (!closing) print(String(error));
      }).finally(() => {
        pending--;
        if (!pending) { clearInterval(spinner); spinner = undefined; }
        if (!closing) drawPrompt();
      });
    }
    terminal?.prompt();
    drawPrompt();
  });
  terminal.prompt();
  try { await closed; }
  finally {
    subscription.close();
    terminal.close();
    await subscription.done;
  }
}
