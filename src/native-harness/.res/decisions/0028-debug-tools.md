# 0028. Opt-in development debug tools

Free-form testing needs small, predictable tool calls and a way to compare the
agent's account against the actual request. A fixed scenario couples these
checks to a specific prompt. Development startup instead accepts
`--debug-tools` to offer echo, bounded wait, and intentional failure through the
ordinary policy gate. `--debug` offers those tools and uses the bundled
test-agent prompt for the active process, preserving saved agent text. Wait honors the turn's abort signal. Failures use the
existing paired result and outcome format, with string-only executors still
supported. The flag applies to one process and is not persisted.

The existing development inspector identifies included and trimmed candidates
by timeline sequence, lists offered tools, and links captured requests to
durable model-call summaries. Candidate diagnostics describe the bounded read
and assembly. They do not enumerate older history outside the read window.
Existing capture controls apply.
