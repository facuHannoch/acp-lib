import type { ReminderChange } from "../../native-harness/src/client.ts";
import type { reminderRequest } from "./wire.ts";

type AssignableToWire<T extends ReminderChange> = T;
type Encoded = AssignableToWire<ReturnType<typeof reminderRequest>>;

type Create = Extract<Encoded, { op: "create" }>;
type MissingAcceptance = Omit<Create, "payload"> & {
  payload: Omit<Create["payload"], "acceptedAt">;
};

// @ts-expect-error The harness requires the original acceptance instant on create.
type MustRejectMissingAcceptance = AssignableToWire<MissingAcceptance>;
