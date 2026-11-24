import { expect, test } from "bun:test";
import { unattendedAdmission } from "../src/capabilities/reminders/unattended.ts";

test("an exhausted channel admits participant work but cannot spend another unattended slot", () => {
  expect(unattendedAdmission(1, 0, false)).toEqual({ eligible: true, nextSpent: 1 });
  expect(unattendedAdmission(1, 1, false)).toEqual({ eligible: false, nextSpent: 1 });
  expect(unattendedAdmission(1, 1, true)).toEqual({ eligible: true, nextSpent: 0 });
  expect(unattendedAdmission(undefined, 0, false)).toEqual({ eligible: true, nextSpent: 0 });
});
