# A first harness, built step by step

This is a working Python learning experiment: one conversation, a model reached
through OpenRouter, text-based tool requests, local tool execution, persistent
history, and an inner loop. We built the pieces individually to understand what
the program around a model actually does before implementing the larger native
harness.

The main discovery is that the model requests actions and interprets results;
Python performs the actions and decides when to call the model again.

## Run it

From this directory, with `OPENROUTER_API_KEY` set in your environment:

```sh
uv run --with requests harness.py
```

The script asks for one user message. That message can lead to several model
calls and tool executions before a final answer is printed and the process exits.
Run it again to continue the saved conversation.

Inference uses `requests` to POST to OpenRouter's Chat Completions endpoint with
the model ID `deepseek/deepseek-v4.1-flash`. The API key is an HTTP authorization
header, not part of the model's messages. There is a 120-second HTTP timeout.

## How we got here

1. **One inference call.** Send a message and print the assistant response.
2. **A transcript.** Separate file management into `Transcript`, storing one JSON
   object per line in `conversation.jsonl`.
3. **Visible context.** Save the messages sent on each inference call as a readable
   `conversation/context-n.md` snapshot.
4. **A system prompt.** Read the root `system-prompt.md`, append tool definitions,
   and keep that combined system message first in the transcript.
5. **Tool definitions and parsing.** Teach the model the `TOOL name {arguments}`
   convention; extract its requests without executing them yet.
6. **Tool execution.** Validate arguments, run Python code, and record results.
7. **Persistent tool state.** Simulate sending messages and checking delivery using
   `state.json`.
8. **The inner loop.** After executing a tool, call the model again with the result.
   Stop when it responds without a tool request.

## Model calls, context, and memory

A model call receives context and generates output. Our conversation continuity
comes from explicitly sending history again on every call, not from the model
remembering earlier HTTP requests.

```text
Call 1: system + user
Call 2: system + user + assistant + next user
```

Inside a tool-using turn, the history also includes tool requests and results:

```text
Call 1: system + user
Call 2: system + user + assistant tool request + tool result
Call 3: system + user + assistant tool request + tool result
                     + assistant tool request + tool result
```

`inference_call()` reloads `system-prompt.md` before every request. It combines
that text with the `tools` string and replaces the transcript's system record,
keeping exactly one system message at the beginning. Editing the prompt therefore
affects the next call, including the next call within an ongoing turn. Old context
snapshots retain the earlier versions.

The current prompt gives the agent its name, asks it to speak Italian, and asks
for an introductory sentence before requesting a tool. These are instructions,
not mechanically enforced properties. We saw that a model can omit the sentence;
clearer wording and examples can help, but do not guarantee compliance.

The role labels are meaningful parts of the input. Ultimately the serving system
turns messages into a model-specific token representation, potentially including
special tokens. Our snapshots show the exact message content and roles we send,
not the provider's internal token sequence, hidden processing, or model reasoning.

## Files and responsibilities

| File | Purpose |
| --- | --- |
| `harness.py` | `Transcript`, `HarnessV0`, tool definitions, and terminal entry point |
| `system-prompt.md` | Editable instructions, reloaded before every inference call |
| `conversation.jsonl` | System, user, assistant, and tool records |
| `conversation/context-n.md` | Human-readable input messages for model response number n |
| `state.json` | Current state of simulated messages, under `{"messages": []}` |
| `note.txt` | Created or replaced by `write_note` |
| `doc.md` | A local document used in the read-and-send experiment |

The harness creates `conversation/` if needed. Snapshot numbering counts saved
assistant responses and starts at 1; a manually created `context-0.md` is not the
system prompt source. A failed inference can leave a snapshot for an attempted
response; a retry at that response number can replace that snapshot.

`Transcript` manages prompt loading, JSONL records, and context snapshots.
`HarnessV0` builds requests, parses tool intentions, executes tools, manages tool
state, and coordinates the loop. This small experiment intentionally keeps those
pieces close enough to read together.

## A tool has a definition, a request, an implementation, and a result

The definition tells the model what is available and how to ask for it:

```text
Tool: read_file
Read a UTF-8 file relative to the sandbox directory.
Required argument: path, a string.

TOOL read_file {"path": "doc.md"}
```

The model can generate speech followed by a request in the same assistant response:

```text
Leggo il file doc.md per controllarne il contenuto.
TOOL read_file {"path": "doc.md"}
```

That text does not read a file. `parse_tool()` scans lines for `TOOL `, extracts the
name, and parses the remaining JSON into an argument object:

```json
{"name": "read_file", "arguments": {"path": "doc.md"}}
```

The parser returns the first recognized request, or `None` for an ordinary answer.
Malformed syntax raises an error. It does not check whether the named tool exists
or whether its arguments meet that tool's requirements; execution handles those
checks. Only one request per response is supported.

The assistant record keeps both the original `content` and the parsed `tool_call`.
They represent what the model wrote and how our program interpreted it. The tool
request is still an assistant message. The later tool result is produced by Python.

`run_tool()` dispatches only the supported names and validates their arguments.
It returns a JSON-shaped result with `name`, `ok`, and either `result` or `error`.
Expected execution errors are returned as data, so the next model call can explain
them or request another action.

### Available tools

| Tool | Arguments | Effect |
| --- | --- | --- |
| `read_file` | Required string `path` | Reads UTF-8 text within this sandbox directory |
| `write_note` | Required string `text` | Replaces the fixed sandbox file `note.txt` |
| `send_message` | Optional string `text`, default `Hello` | Simulates a send and stores a message |
| `message_status` | Required string `message_id` | Checks a stored message and advances delivery when due |

Resolved file paths are checked to stay within the sandbox. These are local Python
operations; `send_message` does not contact a real recipient.

### How results reach the model

We store tool results as `role: "tool"` in JSONL. Because this experiment uses a
custom text convention, it has no native API tool-call IDs. When building an API
request, the harness translates these records into user-role messages containing:

```text
TOOL_RESULT {"name":"read_file","ok":true,"result":{"content":"..."}}
```

This is our protocol for supplying observations to the model. The saved `tool_call`
metadata is not sent as native API `tool_calls`; its original text remains in the
assistant's content. Tool outputs may contain arbitrary file text and should be
treated as data, not instructions.

## State is different from history

`conversation.jsonl` records what happened. `state.json` records current simulated
message state. A stored message looks like:

```json
{
  "messages": [
    {
      "id": "a-generated-uuid",
      "text": "Hello",
      "status": "sent",
      "deliver_at": 2000000005.0
    }
  ]
}
```

`send_message` randomly chooses `sent` or `failed`. A sent message gets a delivery
time five seconds in the future. `message_status` changes it to `delivered` when
checked at or after that time. Failed messages stay failed.

This is a lazy simulation: no timer or background process delivers anything.
The timestamp and state survive restarting the script, and a later check performs
the transition. Updating state does not itself inform the model; the model learns
about it through a later tool result.

Two levels of success are distinct:

```json
{"name":"send_message","ok":true,"result":{"message_id":"...","status":"failed"}}
```

Here the Python tool executed successfully, but the simulated sending attempt
failed. The original transcript result remains unchanged even if a later status
check updates the message's current state.

## The inner loop

The essential control flow is:

```text
Append the user's message once
Repeat:
    Build context and call the model
    Parse and save the assistant response
    If there is no tool request: return the answer
    Execute the tool and save its result
```

We do not encode a separate task-completion judge. Responding without a tool request
ends the turn. Whether the model fulfilled the user's request is a separate quality
question: a model can stop too early or make an incorrect claim.

Our read-and-send experiment demonstrated three model calls from one user message:

```text
user       Read doc.md and send its contents.
assistant  TOOL read_file {"path":"doc.md"}           ← model call 1
tool       Actual file contents                        ← Python
assistant  TOOL send_message {"text":"...contents..."} ← model call 2
tool       Message ID and sent/failed status            ← Python
assistant  Explains the outcome                        ← model call 3
```

The second action depends on the first result, so the model must receive that result
in a new call before it can construct the send request. Previously read content may
already be in history, but it may also be stale.

In the inspected transcript, the model also removed some blank lines while copying
the document into the send arguments. The text matched when ignoring whitespace,
but the bytes differed. Asking the model to reproduce data is not a guarantee of
exact copying; an operation that passes a file directly would avoid that problem.

## Our convention versus native tooling

Our model generates ordinary assistant text containing a `TOOL` line, and our code
recognizes it. This makes every step visible for learning.

With native tooling, an application supplies definitions through the API's `tools`
field. The serving system prepares them in the model's supported format and
interprets generated output into fields such as `content` and `tool_calls`.
The returned JSON is an API representation; it need not be the literal token
sequence the model generated. Formats can involve JSON, special delimiters, or both.

The distinction is not that native calls magically execute functions. Application
code still executes client tools and supplies results. Native tooling provides a
supported convention and structured interface rather than our handwritten protocol.
See [OpenRouter tool calling](https://openrouter.ai/docs/guides/features/tool-calling).

Schema-constrained generation is another mechanism: where supported, the serving
system restricts generated tokens to enforce structure. Merely asking for JSON in
a prompt does not provide that enforcement. Format correctness also does not prove
the requested operation or arguments are appropriate. Serving implementations and
strictness vary; [vLLM documents templates, parsers, and constraints](https://docs.vllm.ai/en/latest/features/tool_calling/).

## What this milestone covers

This is a working basic harness: context assembly, inference, tool interpretation,
execution, persistence, state, and repeated calls within one turn.

The outer loop concerns what starts turns. Currently a person runs the script and
enters a message. There are no autonomous wakes when a message becomes delivered,
background event processing, or multiple conversations.

The code also has no model-call limit yet: `model_call()` uses `while True`.
Repeated tool requests can continue indefinitely. Malformed tool syntax and HTTP
errors still raise exceptions; context grows without compaction, and there is no
streaming, cancellation, permission system, or concurrent state-write coordination.
Intermediate assistant explanations are saved in the transcript; the terminal
prints tool results and the final answer, not each intermediate explanation.

Those are further responsibilities around the same core mechanism. The broader
[native harness architecture](../../../ARCHITECTURE.md) and
[v1 scope](../../../../../.res/somelogs.md/11-11+/harness/11-11-SPEC-harness-v1.md)
describe that destination. This sandbox completes the hello-world milestone.
