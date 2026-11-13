import json
import os
from pathlib import Path

import requests


class Transcript:
    def __init__(self, path):
        self.path = Path(path)
        self.conversation_dir = self.path.parent / "conversation"
        self.conversation_dir.mkdir(parents=True, exist_ok=True)

    def read_system_prompt(self):
        return (self.path.parent / "system-prompt.md").read_text(encoding="utf-8")

    def update_system(self, tools):
        records = self.read()
        system = {
            "role": "system",
            "content": f"{self.read_system_prompt()}\n\n{tools}",
        }
        history = [record for record in records if record["role"] != "system"]
        with self.path.open("w", encoding="utf-8") as file:
            for record in [system, *history]:
                file.write(json.dumps(record, ensure_ascii=False) + "\n")

    def save_context(self, messages, response_number):
        path = self.conversation_dir / f"context-{response_number}.md"
        with path.open("w", encoding="utf-8") as file:
            for message in messages:
                file.write(f"# {message['role']}\n\n")
                file.write(message["content"] or "")
                file.write("\n\n")

    def write(self, role, content, context=None, tool_call=None):
        message = {"role": role, "content": content}
        if context is not None:
            message["context"] = context
        if tool_call is not None:
            message["tool_call"] = tool_call
        with self.path.open("a", encoding="utf-8") as file:
            file.write(json.dumps(message, ensure_ascii=False) + "\n")

    def read(self):
        if not self.path.exists():
            return []

        with self.path.open(encoding="utf-8") as file:
            return [json.loads(line) for line in file if line.strip()]

class HarnessV0:
    def __init__(self, transcript, tools):
        self.transcript = transcript
        self.tools = tools
        self.latest_answer = None
        self.transcript.update_system(tools)

    def inference_call(self):
        self.transcript.update_system(self.tools)
        history = self.transcript.read()
        messages = [
            {"role": record["role"], "content": record["content"]}
            for record in history
        ]
        response_number = sum(record["role"] == "assistant" for record in history) + 1
        self.transcript.save_context(messages, response_number)
        request_body = {
            "model": "deepseek/deepseek-v4.1-flash",
            "messages": messages,
        }

        response = requests.post(
            "https://openrouter.ai/api/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {os.environ['OPENROUTER_API_KEY']}"
            },
            json=request_body,
            timeout=120,
        )
        if not response.ok:
            print(response.text)
        response.raise_for_status()
        payload = response.json()

        answer = payload["choices"][0]["message"]
        answer["context"] = messages
        self.latest_answer = answer
        return answer
    
    def parse_tool(self, content):
        for line in (content or "").splitlines():
            line = line.strip()
            if not line.startswith("TOOL "):
                continue

            parts = line.split(maxsplit=2)
            if len(parts) != 3:
                raise ValueError('Expected: TOOL tool_name {"argument": "value"}')

            _, name, raw_arguments = parts
            try:
                arguments = json.loads(raw_arguments)
            except json.JSONDecodeError as error:
                raise ValueError(f"Invalid JSON arguments for {name}: {error.msg}") from error

            if not isinstance(arguments, dict):
                raise ValueError(f"Arguments for {name} must be a JSON object")

            return {"name": name, "arguments": arguments}

        return None
    
    def run_tool(self, tool):
        print("tool called")
        pass


    def model_call(self, prompt):
        self.transcript.write("user", prompt)
        answer = self.inference_call()
        # 2 Tool parsing: recognize the request; execution comes next.
        tool_call = self.parse_tool(answer["content"])
        if tool_call is not None:
            self.run_tool(tool_call)
            answer["tool_call"] = tool_call

        self.transcript.write(
            "assistant", answer["content"],
            # context=answer["context"],
            tool_call=tool_call,
        )
        return answer


tools = """
Tools definitions:

Tool: read_file
Description: Read a UTF-8 text file from the sandbox directory.
Arguments:
- path: required string, relative to the sandbox directory. Preserve the requested path exactly.

Request format:
Leggo il file .res/things.md per controllarne il contenuto.
TOOL read_file {"path": ".res/things.md"}

Put all arguments in the JSON object. Only the TOOL request must occupy one line;
the introductory sentence goes on the preceding line.
Result:
The harness returns the file contents, or an error if it cannot read it.
Requesting the tool does not itself read the file.


Write a note
TOOL write_note {}
"""

if __name__ == "__main__":
    transcript = Transcript(Path(__file__).with_name("conversation.jsonl"))
    harness = HarnessV0(transcript, tools)
    prompt = input("> ")
    answer = harness.model_call(prompt)
    print(answer["content"])

