import { LineDecoder } from "../../native-harness/src/interfaces/protocol/framing.ts";
import { reminderNotification, type ReminderNotification } from "./wire.ts";

/** The bundled pre-0031 transport rejects new event kinds. Consume just those
 * notifications here and leave its existing protocol validation in place. */
export function separateReminderNotifications(
  readable: ReadableStream<Uint8Array>,
  accept: (event: ReminderNotification) => void,
): ReadableStream<Uint8Array> {
  const decoder = new LineDecoder();
  const encoder = new TextEncoder();
  return readable.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      for (const line of decoder.push(chunk)) {
        const notification = reminderNotification(JSON.parse(line));
        if (notification) accept(notification);
        else controller.enqueue(encoder.encode(line + "\n"));
      }
    },
    flush() { decoder.finish(); },
  }));
}
