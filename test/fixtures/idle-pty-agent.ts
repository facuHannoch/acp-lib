#!/usr/bin/env bun

process.stdout.write("idle pty ready> ");
if (process.argv.includes("--ack-input")) {
  process.stdin.once("data", () => process.stdout.write("idle pty received input\n"));
}
process.stdin.resume();
