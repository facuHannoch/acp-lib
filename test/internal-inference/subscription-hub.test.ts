import { describe, expect, test } from "bun:test";
import { SubscriptionHub } from "../../src/observation/subscription-hub.ts";

describe("SubscriptionHub", () => {
  test("preserves order, isolates failures, and makes unsubscribe idempotent", () => {
    const calls: string[] = [];
    const failures: unknown[] = [];
    const hub = new SubscriptionHub<number>((failure) => failures.push(failure.error));
    const unsubscribe = hub.subscribe(() => {
      calls.push("first");
      throw new Error("listener failed");
    });
    hub.subscribe(() => calls.push("second"));

    hub.emit(1);
    unsubscribe();
    unsubscribe();
    hub.emit(2);

    expect(calls).toEqual(["first", "second", "second"]);
    expect(failures).toHaveLength(1);
  });

  test("snapshots listeners before emitting", () => {
    const calls: string[] = [];
    const hub = new SubscriptionHub<void>();
    let removeSecond = () => {};
    hub.subscribe(() => {
      calls.push("first");
      removeSecond();
      hub.subscribe(() => calls.push("third"));
    });
    removeSecond = hub.subscribe(() => calls.push("second"));

    hub.emit();
    expect(calls).toEqual(["first", "second"]);
  });
});
