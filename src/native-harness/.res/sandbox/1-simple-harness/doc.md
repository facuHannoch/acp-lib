




```json
{
  "type": "function",
  "function": {
    "name": "read_file",
    "description": "Read a UTF-8 text file from the sandbox directory.",
    "parameters": {
      "type": "object",
      "properties": {
        "path": {
          "type": "string",
          "description": "Path relative to the sandbox directory."
        }
      },
      "required": ["path"],
      "additionalProperties": false
    }
  }
}
```




## 


- prompt convention
- native tool calling
- constrained generation






**the model family defines a tool-use format it understands; the serving system supports that format.** It isn’t necessarily a new convention invented by every inference provider.

There are three layers:

1. **Model:** trained to recognize tool definitions and generate tool requests in a particular format.
2. **Serving system:** prepares the input, interprets the generated output, and may constrain generation.
3. **Public API:** presents the result as fields such as `content` and `tool_calls`.

For example:

```text
You send:
  messages + tools
        ↓
Server prepares the model-specific input
        ↓
Model generates tokens:
  explanation + tool markers + name + arguments
        ↓
Server interprets those tokens
        ↓
You receive:
  content + tool_calls
```

That’s how systems such as vLLM support multiple model families using matching templates and tool parsers. Enforcement is separate: some configurations allow unconstrained generation and parse afterward; others constrain tool structure or argument schemas during generation. Hosted providers may keep those implementation details private. [vLLM tool calling](https://docs.vllm.ai/en/latest/features/tool_calling/).

**The model still generates tokens, yes—but not necessarily lots of ordinary text.** Some tokens represent words, others can be special markers. It might generate just a short tool request, with no explanation at all.



## Continuous tool calls

```
while True:
    answer = inference_call()
    tool_call = parse_tool(answer["content"])
    save_assistant(answer, tool_call)

    if tool_call is None:
        return answer

    result = run_tool(tool_call)
    save_tool_result(result)
    # Go around again: the model needs to see the result.
```