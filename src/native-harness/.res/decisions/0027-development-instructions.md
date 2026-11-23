# 0027. Editable development instructions

The development startup prompt and tool list assumed the original scripted demo. This
made live sessions harder to use for arbitrary work or tune between launches.

Editing a TypeScript literal required working in the runtime configuration code.
A shared prompt registry would give the harness ownership of consumer text.
The development CLI instead loads bundled Markdown or an explicit
`--instructions <path>` override. It reads the file once, preserving its text,
and passes the resolved string through the existing system field. The explicit
override wins for that open, including when a sidecar supplies the other
configuration fields. SQLite and archives retain only the resolved text.
Bundled instruction text lives in the context capability's instructions
directory, with a Markdown file for each of the agent, the harness, and the
agent demo.

The live development tool list contains the clock and channel notices.
Scripted development uses the generic test-agent prompt when selected with
`--script`. Individual test fixtures can supply their own tools. Existing saved configuration remains eligible
for new turns. A suspended turn still has to pass the existing compatibility
check, so a changed prompt or the removed live demo tool can prevent resume.
The session config and wire shapes stay the same.
