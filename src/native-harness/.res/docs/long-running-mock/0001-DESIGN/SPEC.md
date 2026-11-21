# Long-running mock mode

Date: 2026-11-21.
Status: proposed for review. See [PLAN.md](PLAN.md) for module ownership,
implementation gates, and the final driven rehearsal.

## Goal

Run repeatable offline rehearsals with the real native harness and acp-client.
Use the same scenario file format for short deterministic tests and workloads
lasting minutes or hours. The rehearsal can simulate model output and tool
effects while exercising real channel scheduling, inference boundaries,
permissions, callbacks, persistence, and control operations.

Build on the [acp-client integration](../../acp-client-integration/0001-DESIGN/SPEC.md),
[host callbacks](../../tools-and-callbacks/0001-DESIGN/SPEC.md), and
[operator controls](../../operator-controls/0001-DESIGN/SPEC.md). Use the
existing scripted model, model-attempt reservation, and public stdio client.

## Ownership

| Component | Responsibility |
| --- | --- |
| Scenario file | Describe simulated model attempts and scheduled participant messages. |
| Harness scripted model | Emit the prescribed provider-neutral events in response to a real inference request. |
| Harness session | Own admission, context, model execution, permission checks, tool dispatch, notices, and durable records. |
| Rehearsal driver | Run scheduled inputs through acp-client, observe outcomes, and control the child process when tests require it. |
| Test tool handlers | Simulate controlled delays, holds, failures, and observable effects through the normal tool paths. |

The driver lives outside the harness child and can replace it while the same
run continues. It sends inputs and controls through the consumer APIs. Short
tests can provide their own input and controls in code while using the same
model file format.

## JSONL file

A local UTF-8 JSONL file contains one JSON object per record. The first record
declares the format version. Model and send records can be interleaved. The
loader validates the file before execution and reports malformed or unsupported
records with their line numbers. Convert the existing short JSON fixtures so
there is one supported on-disk script format.

| Record | Fields and behavior |
| --- | --- |
| `scenario` | `version` and a scenario name. Required first record. |
| `model` | Optional channel ID, optional initial delay, and the simulated attempt behavior. Supports text, timed text chunks, tool requests, synthetic usage, a typed provider failure, or a wait that ends on cancellation. A tool request contains the existing call ID, name, and arguments. |
| `send` | Elapsed time from the start in milliseconds, channel ID, participant ID, stable input ID, and text. |

Example of a model-only script for a test that provides its own prompt:

```jsonl
{"type":"scenario","version":1,"name":"clock"}
{"type":"model","channelId":"alice","content":"I’ll check the time.","calls":[{"id":"time-1","name":"current_time","arguments":{}}]}
{"type":"model","channelId":"alice","content":"I checked the time."}
```

One model record describes one attempt. Requesting tools leaves execution to
the harness. Its next attempt consumes another record and receives the real
tool results in context. A prewritten follow-up alone cannot establish that
the tool ran or its result reached the model. Tests use recorded effects and,
when needed, captured requests to verify those boundaries.

## Selection, timing, and recovery

Model records for a channel are consumed in file order for that channel.
Channel-specific sequences take precedence. Model records with no channel ID
form a reusable default sequence for channels that lack a specific sequence.
Each such channel has its own position, preserving the existing short-fixture
behavior. Exhausting the selected sequence reports `script_exhausted`.

In a durable session, reuse the existing per-channel model-attempt reservation.
A retry consumes another record. A crash after reservation leaves that record
consumed. Keep the scenario fixed for the run and verify the script's identity
on reopen before continuing. Report an incompatible script explicitly. The
driver retains its scheduled-action position across a child restart. Persisting
and restarting the driver itself is outside this slice.

Scheduled sends use elapsed time from a monotonic run clock. Sends with the
same timestamp are issued in file order. Independent channels can overlap, so
issuing a send does not wait for that turn to complete. Record actual execution
order for diagnosis. Model delays and fixture waits honor cancellation. They
exercise the normal model, approval, and tool boundaries and their configured
deadlines.

CI uses barriers in test code. For example, a hold handler signals entry and
waits for release. The test sends Bob's input after that signal, waits for Bob's
turn to finish, then releases Alice's handler. Detach, approval, interruption,
suspension, and restart can also be scripted in test code through the existing
APIs. The file format in this slice schedules sends. General event triggers and
file-driven control commands can follow later.

## Tools and notices

`notify_channel` is a harness-owned tool supplied by default in each session.
The harness provides both its definition and handler. It uses the existing
permission and channel admission paths. A model record can request it and the
target consumes its next model response if the notice wakes a turn. A driver
notification command is outside this slice. The mock exercises channel notices;
topic notices can follow when the built-in topic capability is available.

Reuse controlled test tools and add a small set of fixture handlers for quiet
callbacks, delayed results, failures, and observable effects. The fixture owns
its effects. The harness owns approval, cancellation, pairing results with
calls, and crash recovery. Uncertain effects follow the existing no-replay rule.

## Run results

Run against a fresh test session by default. A restart case deliberately reopens
that same session. After all scheduled sends are issued, allow expected work to
settle within a configured run deadline. Report unfinished work, unexpected
failures, and unused model records. A test can explicitly expect interruption,
failure, or timeout.

Record a compact event log and summary with run duration, sent inputs, turn
outcomes, callback effects where observed, and duplicate or missed committed
replies where the driver has evidence. Keep full inference-request capture
opt-in so long runs avoid copying the growing shared history into a capture log
for every attempt. Generate synthetic fixtures before running them. Fixture
authors can use real timing and event patterns as a guide.

## Acceptance

1. Convert existing fixture coverage to JSONL and verify a model-only script
   works through the scripted harness. Reject malformed records, report a
   missing response explicitly, and verify independent channel positions.
2. Run a deterministic acp-client test with a real stdio child. Alice streams
   text and waits on a controlled callback while Bob completes. Exercise
   approval through the normal gate, then verify targeted interruption leaves
   Bob unaffected. Assert the callback and committed results from observed
   evidence.
3. Detach a conversation, let a built-in channel notice start work there, and
   recover the committed reply exactly once after reattachment. Suspend with
   work in progress, replace the child, and resume from the checkpoint without
   repeating a committed effect. Exercise abrupt interruption separately and
   verify a reserved attempt and an uncertain effect are not replayed.
4. Run a multi-minute timed fixture with bursts, idle gaps, concurrent
   channels, and short and tool-heavy turns. Verify the driver finishes within
   the configured run deadline, accounts for terminal outcomes, and leaves no
   child process running. The same driver accepts hour-scale fixtures. All
   runs work without contacting a model provider.
