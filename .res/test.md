
# Initialize

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": 1,
    "capabilities": {},
    "clientInfo": {
      "name": "acp-lib",
      "title": "ACP Lib",
      "version": "0.1.0"
    }
  }
}
```



```json
{ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": 1, "capabilities": {}, "clientInfo": { "name": "acp-lib", "title": "ACP Lib", "version": "0.1.0" } } }
```


### Response

```json
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentInfo":{"name":"@agentclientprotocol/codex-acp","title":"Codex","version":"0.0.46"},"agentCapabilities":{"auth":{"logout":{}},"loadSession":true,"promptCapabilities":{"embeddedContext":true,"image":true},"sessionCapabilities":{"resume":{},"list":{},"close":{}},"mcpCapabilities":{"acp":false,"http":true,"sse":false}},"authMethods":[{"id":"api-key","name":"API Key","description":"Use an API key to authenticate","_meta":{"api-key":{"provider":"openai"}}},{"id":"chat-gpt","name":"ChatGPT","description":"Use ChatGPT to authenticate"}]}}
```



If I try to reinitialize

```json
Error handling request {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: 1,
    capabilities: {},
    clientInfo: { name: 'acp-lib', title: 'ACP Lib', version: '0.1.0' }
  }
} {
  code: -32603,
  message: 'Internal error',
  data: { details: 'Already initialized' }
}
{"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"Internal error","data":{"details":"Already initialized"}}}
```


**On error it returns an error attribute with the details in data.


---

## Initialize with all capabilities

```json
{ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": 1, "capabilities": { "fs": { "readTextFile": true, "writeTextFile": true }, "terminal": true }, "clientInfo": { "name": "acp-lib", "title": "ACP Lib", "version": "0.1.0" } } }
```


```json
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentInfo":{"name":"@agentclientprotocol/codex-acp","title":"Codex","version":"0.0.46"},"agentCapabilities":{"auth":{"logout":{}},"loadSession":true,"promptCapabilities":{"embeddedContext":true,"image":true},"sessionCapabilities":{"resume":{},"list":{},"close":{}},"mcpCapabilities":{"acp":false,"http":true,"sse":false}},"authMethods":[{"id":"api-key","name":"API Key","description":"Use an API key to authenticate","_meta":{"api-key":{"provider":"openai"}}},{"id":"chat-gpt","name":"ChatGPT","description":"Use ChatGPT to authenticate"}]}}
```



# Authentication

## Authenticate

```json
{ "jsonrpc": "2.0", "id": 1, "method": "authenticate", "params": { "methodId": "api-key" } }
```

```json
{ "jsonrpc": "2.0", "id": 2, "method": "authenticate", "params": { "methodId": "chat-gpt" } }
```

**Certain providers do not support login via ACP. They may just respond with `{"jsonrpc":"2.0","id":2,"result":{}}` but this does not mean that you are authenticated**. Kimi, for instance, will do this, and if you send a prompt it will just end it right away.

```json
{"jsonrpc":"2.0","id":1,"result":{"agentCapabilities":{"loadSession":true,"mcpCapabilities":{"http":true,"sse":false},"promptCapabilities":{"audio":false,"embeddedContext":true,"image":true},"sessionCapabilities":{"list":{},"resume":{}}},"agentInfo":{"name":"Kimi Code CLI","version":"1.47.0"},"authMethods":[{"_meta":{"terminal-auth":{"command":"/home/devuser/.local/bin/kimi","args":["login"],"label":"Kimi Code Login","env":{},"type":"terminal"}},"description":"Run `kimi login` command in the terminal, then follow the instructions to finish login.","id":"login","name":"Login with Kimi account"}],"protocolVersion":1}}

{ "jsonrpc": "2.0", "id": 2, "method": "authenticate", "params": { "methodId": "login" } }
{"jsonrpc":"2.0","id":2,"result":{}}


{ "jsonrpc": "2.0", "id": 7, "method": "session/prompt", "params": { "sessionId": "cc8795a7-b0ac-4f97-af9c-c48142b1e3bf", "prompt": [{ "type": "text", "text": "What model are you,? change every letter for a number" }] } }

{"jsonrpc":"2.0","id":7,"result":{"stopReason":"end_turn"}}

```

---

## Logout

```json
{ "jsonrpc": "2.0", "id": 3, "method": "logout", "params": {} }
```


# Session

## session/new

```json
{ "jsonrpc": "2.0", "id": 4, "method": "session/new", "params": { "cwd": "~/libs/acp-lib", "mcpServers": [] } }
```


```json
s{"jsonrpc":"2.0","id":4,"result":{"sessionId":"019ec85b-ac04-7fa3-bfdd-4b0b488e50a2","models":{"availableModels":[{"modelId":"gpt-5.5[low]","name":"GPT-5.5 (low)","description":"Frontier model for complex coding, research, and real-world work. Fast responses with lighter reasoning"},{"modelId":"gpt-5.5[medium]","name":"GPT-5.5 (medium)","description":"Frontier model for complex coding, research, and real-world work. Balances speed and reasoning depth for everyday tasks"},{"modelId":"gpt-5.5[high]","name":"GPT-5.5 (high)","description":"Frontier model for complex coding, research, and real-world work. Greater reasoning depth for complex problems"},{"modelId":"gpt-5.5[xhigh]","name":"GPT-5.5 (xhigh)","description":"Frontier model for complex coding, research, and real-world work. Extra high reasoning depth for complex problems"},{"modelId":"gpt-5.4[low]","name":"GPT-5.4 (low)","description":"Strong model for everyday coding. Fast responses with lighter reasoning"},{"modelId":"gpt-5.4[medium]","name":"GPT-5.4 (medium)","description":"Strong model for everyday coding. Balances speed and reasoning depth for everyday tasks"},{"modelId":"gpt-5.4[high]","name":"GPT-5.4 (high)","description":"Strong model for everyday coding. Greater reasoning depth for complex problems"},{"modelId":"gpt-5.4[xhigh]","name":"GPT-5.4 (xhigh)","description":"Strong model for everyday coding. Extra high reasoning depth for complex problems"},{"modelId":"gpt-5.4-mini[low]","name":"GPT-5.4-Mini (low)","description":"Small, fast, and cost-efficient model for simpler coding tasks. Fast responses with lighter reasoning"},{"modelId":"gpt-5.4-mini[medium]","name":"GPT-5.4-Mini (medium)","description":"Small, fast, and cost-efficient model for simpler coding tasks. Balances speed and reasoning depth for everyday tasks"},{"modelId":"gpt-5.4-mini[high]","name":"GPT-5.4-Mini (high)","description":"Small, fast, and cost-efficient model for simpler coding tasks. Greater reasoning depth for complex problems"},{"modelId":"gpt-5.4-mini[xhigh]","name":"GPT-5.4-Mini (xhigh)","description":"Small, fast, and cost-efficient model for simpler coding tasks. Extra high reasoning depth for complex problems"}],"currentModelId":"gpt-5.5[medium]"},"modes":{"availableModes":[{"id":"read-only","name":"Read-only","description":"Requires approval to edit files and run commands."},{"id":"agent","name":"Agent","description":"Read and edit files, and run commands."},{"id":"agent-full-access","name":"Agent (full access)","description":"Codex can edit files outside this workspace and run commands with network access. Exercise caution when using."}],"currentModeId":"agent"},"configOptions":[{"id":"mode","name":"Mode","description":"Approval and sandboxing preset for the session","category":"mode","type":"select","currentValue":"agent","options":[{"value":"read-only","name":"Read-only","description":"Requires approval to edit files and run commands."},{"value":"agent","name":"Agent","description":"Read and edit files, and run commands."},{"value":"agent-full-access","name":"Agent (full access)","description":"Codex can edit files outside this workspace and run commands with network access. Exercise caution when using."}]},{"id":"model","name":"Model","description":"Model Codex uses for the session","category":"model","type":"select","currentValue":"gpt-5.5","options":[{"value":"gpt-5.5","name":"GPT-5.5","description":"Frontier model for complex coding, research, and real-world work."},{"value":"gpt-5.4","name":"GPT-5.4","description":"Strong model for everyday coding."},{"value":"gpt-5.4-mini","name":"GPT-5.4-Mini","description":"Small, fast, and cost-efficient model for simpler coding tasks."}]},{"id":"reasoning_effort","name":"Reasoning effort","description":"How much reasoning effort the model should use","category":"thought_level","type":"select","currentValue":"medium","options":[{"value":"low","name":"low","description":"Fast responses with lighter reasoning"},{"value":"medium","name":"medium","description":"Balances speed and reasoning depth for everyday tasks"},{"value":"high","name":"high","description":"Greater reasoning depth for complex problems"},{"value":"xhigh","name":"xhigh","description":"Extra high reasoning depth for complex problems"}]},{"id":"fast-mode","name":"Fast mode","description":"1.5x speed, increased usage","category":"fast-mode","type":"select","currentValue":"off","options":[{"value":"off","name":"Off","description":"Default speed, normal usage"},{"value":"on","name":"On","description":"1.5x speed, increased usage"}]}]}}
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"019ec85b-ac04-7fa3-bfdd-4b0b488e50a2","update":{"sessionUpdate":"available_commands_update","availableCommands":[{"name":"mcp","description":"List configured Model Context Protocol (MCP) tools.","input":null},{"name":"skills","description":"List available skills.","input":null},{"name":"status","description":"Display session configuration and token usage.","input":null},{"name":"logout","description":"Sign out of Codex. This option is available when you are logged in via ChatGPT.","input":null},{"name":"$figma:figma-code-connect","description":"Creates and maintains Figma Code Connect template files that map Figma components to code snippets. Use when the user mentions Code Connect, Figma component mapping, design-to-code translation, or asks to create/update .figma.ts or .figma.js files.","input":null},{"name":"$figma:figma-create-new-file","description":"**MANDATORY prerequisite** — you MUST invoke this skill BEFORE every `create_new_file` tool call. NEVER call `create_new_file` directly without loading this skill first. Trigger whenever the user wants a new blank Figma file — a new design, FigJam, or Slides file — or when you need a fresh file before calling `use_figma`. Usage — /figma-create-new-file [editorType] [fileName] (e.g. /figma-create-new-file figjam My Whiteboard, /figma-create-new-file slides Q3 Review)","input":null},{"name":"$figma:figma-generate-design","description":"Use this skill alongside figma-use when the task involves translating an application page, view, or multi-section layout into Figma. Triggers: 'write to Figma', 'create in Figma from code', 'push page to Figma', 'take this app/page and build it in Figma', 'create a screen', 'build a landing page in Figma', 'update the Figma screen to match code', 'convert this modal/dialog/drawer/panel to Figma'. This is the preferred workflow skill whenever the user wants to build or update a full page, modal, dialog, drawer, sidebar, panel, or any composed multi-section view in Figma from code or a description. Discovers design system components, variables, and styles from Code Connect files, existing screens, and library search, then imports them and assembles views incrementally section-by-section using design system tokens instead of hardcoded values.","input":null},{"name":"$figma:figma-generate-diagram","description":"MANDATORY prerequisite — load this skill BEFORE every `generate_diagram` tool call. NEVER call `generate_diagram` directly without loading this skill first. Trigger whenever the user asks to create, generate, draw, render, sketch, or build a diagram — flowchart, architecture diagram, sequence diagram, ERD or entity-relationship diagram, state diagram or state machine, gantt chart, or timeline. Also trigger when the user mentions Mermaid syntax or wants a system architecture, decision tree, dependency graph, API call flow, auth handshake, schema, or pipeline visualized in FigJam. Routes to type-specific guidance, sets universal Mermaid constraints, and tells you when to use a different diagram type or skip the tool entirely (mindmaps, pie charts, class diagrams, etc.).","input":null},{"name":"$figma:figma-generate-library","description":"Build or update a professional-grade design system in Figma from a codebase. Use when the user wants to create variables/tokens, build component libraries, create individual components with proper variant sets and variable bindings, set up theming (light/dark modes), document foundations, or reconcile gaps between code and Figma. Also use when the user asks to create or generate any component in Figma — even a single one — since components require proper variable foundations, variant states, and design token bindings to be production-quality. This skill teaches WHAT to build and in WHAT ORDER — it complements the `figma-use` skill which teaches HOW to call the Plugin API. Both skills should be loaded together.","input":null},{"name":"$figma:figma-use","description":"**MANDATORY prerequisite** — you MUST invoke this skill BEFORE every `use_figma` tool call. NEVER call `use_figma` directly without loading this skill first. Skipping it causes common, hard-to-debug failures. Trigger whenever the user wants to perform a write action or a unique read action that requires JavaScript execution in the Figma file context — e.g. create/edit/delete nodes, set up variables or tokens, build components and variants, modify auto-layout or fills, bind variables to properties, or inspect file structure programmatically.","input":null},{"name":"$figma:figma-use-figjam","description":"This skill helps agents use Figma's use_figma MCP tool in the FigJam context. Can be used alongside figma-use which has foundational context for using the use_figma tool.","input":null},{"name":"$figma:figma-use-slides","description":"This skill helps agents use Figma's use_figma MCP tool in the Slides context. Can be used alongside figma-use which has foundational context for using the use_figma tool.","input":null},{"name":"$find-skills","description":"Helps users discover and install agent skills when they ask questions like \"how do I do X\", \"find a skill for X\", \"is there a skill that can...\", or express interest in extending capabilities. This skill should be used when the user is looking for functionality that might exist as an installable skill.","input":null},{"name":"$imagegen","description":"Generate or edit raster images when the task benefits from AI-created bitmap visuals such as photos, illustrations, textures, sprites, mockups, or transparent-background cutouts. Use when Codex should create a brand-new image, transform an existing image, or derive visual variants from references, and the output should be a bitmap asset rather than repo-native code or vector. Do not use when the task is better handled by editing existing SVG/vector/code-native assets, extending an established icon or logo system, or building the visual directly in HTML/CSS/canvas.","input":null},{"name":"$openai-docs","description":"Use when the user asks how to build with OpenAI products or APIs, asks about Codex itself or choosing Codex surfaces, needs up-to-date official documentation with citations, help choosing the latest model for a use case, or model upgrade and prompt-upgrade guidance; use OpenAI docs MCP tools for non-Codex docs questions, use the Codex manual helper first for broad Codex self-knowledge, and restrict fallback browsing to official OpenAI domains.","input":null},{"name":"$plugin-creator","description":"Create and scaffold plugin directories for Codex with a required `.codex-plugin/plugin.json`, optional plugin folders/files, valid manifest defaults, and personal-marketplace entries by default. Use when Codex needs to create a new personal plugin, add optional plugin structure, generate or update marketplace entries for plugin ordering and availability metadata, or update an existing local plugin during development with the CLI-driven cachebuster and reinstall flow.","input":null},{"name":"$skill-creator","description":"Create or update a skill","input":null},{"name":"$skill-installer","description":"Install curated skills from openai/skills or other repos","input":null}]}}}
```

```json
{"jsonrpc":"2.0","id":4,"result":{"models":{"availableModels":[{"modelId":"kimi-code/kimi-for-coding","name":"kimi-for-coding"},{"modelId":"kimi-code/kimi-for-coding,thinking","name":"kimi-for-coding (thinking)"}],"currentModelId":"kimi-code/kimi-for-coding,thinking"},"modes":{"availableModes":[{"description":"The default mode.","id":"default","name":"Default"}],"currentModeId":"default"},"sessionId":"f072ac26-00b8-4bd2-b497-6014adeedf4e"}}
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"f072ac26-00b8-4bd2-b497-6014adeedf4e","update":{"availableCommands":[{"description":"Analyze the codebase and generate an `AGENTS.md` file","name":"init"},{"description":"Compact the context (optionally with a custom focus, e.g. /compact keep db discussions)","name":"compact"},{"description":"Clear the context","name":"clear"},{"description":"Toggle YOLO mode (auto-approve all actions)","name":"yolo"},{"description":"Toggle afk mode (auto-dismiss AskUserQuestion, auto-approve tool calls)","name":"afk"},{"description":"Toggle plan mode. Usage: /plan [on|off|view|clear]","name":"plan"},{"description":"Add a directory to the workspace. Usage: /add-dir <path>. Run without args to list added dirs","name":"add-dir"},{"description":"Export current session context to a markdown file","name":"export"},{"description":"Import context from a file or session ID","name":"import"}],"sessionUpdate":"available_commands_update"}}}

```


```json
{"jsonrpc":"2.0","id":4,"result":{"sessionId":"ses_137b1a4c8ffepojMt7GXpsbmtl","configOptions":[{"id":"model","name":"Model","category":"model","type":"select","currentValue":"opencode/big-pickle","options":[{"value":"opencode/big-pickle","name":"OpenCode Zen/Big Pickle"},{"value":"opencode/deepseek-v4-flash-free","name":"OpenCode Zen/DeepSeek V4 Flash Free"},{"value":"opencode/mimo-v2.5-free","name":"OpenCode Zen/MiMo V2.5 Free"},{"value":"opencode/nemotron-3-ultra-free","name":"OpenCode Zen/Nemotron 3 Ultra Free"},{"value":"opencode/north-mini-code-free","name":"OpenCode Zen/North Mini Code Free"}]},{"id":"mode","name":"Session Mode","category":"mode","type":"select","currentValue":"build","options":[{"value":"build","name":"build","description":"The default agent. Executes tools based on configured permissions."},{"value":"plan","name":"plan","description":"Plan mode. Disallows all edit tools."}]}]}}
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"ses_137b1a4c8ffepojMt7GXpsbmtl","update":{"sessionUpdate":"available_commands_update","availableCommands":[{"name":"customize-opencode","description":"Use ONLY when the user is editing or creating opencode's own configuration: opencode.json, opencode.jsonc, files under .opencode/, or files under ~/.config/opencode/. Also use when creating or fixing opencode agents, subagents, skills, plugins, MCP servers, or permission rules. Do not use for the user's own application code, or for any project that is not configuring opencode itself."},{"name":"find-skills","description":"Helps users discover and install agent skills when they ask questions like \"how do I do X\", \"find a skill for X\", \"is there a skill that can...\", or express interest in extending capabilities. This skill should be used when the user is looking for functionality that might exist as an installable skill."},{"name":"init","description":"guided AGENTS.md setup"},{"name":"review","description":"review changes [commit|branch|pr], defaults to uncommitted"}]}}}
```



`codex-acp`

result
  - sessionId
  - models
    - availableModels
    - currentModelId
  - modes
    - availableModes
    - currentModeId
  - configOptions
    - mode -> same as modes
    - model -> same as models
    - reasoning_effort
    - fast mode (on / off)

Here mode refers to the level of access the agent has to editing files

`kimi acp`

- result
  - models
    - availableModels
    - currentModelId
  - modes
    - availableModes
    - currentModeId
  - sessionId

- session/update
- params
  - sessionId
  - update
    - availableCommands
      - 
    - sessionUpdate




`opencode acp`

- result
  - sessionId
  - configOptions
    - object with id "models"
    - object with id "mode" -> this refers to build / plan

session/update
- params
  - sessionId
  - availableCommands



## session/close

```json
{ "jsonrpc": "2.0", "id": 5, "method": "session/close", "params": { "sessionId": "019ec838-ebd0-7410-957d-b09852e3bf9a" } }
```

```json
{"jsonrpc":"2.0","id":5,"result":{}}
```

## session/load, session/resume

Since Codex advertises both `loadSession: true` and `sessionCapabilities.resume`, you can do either:

- **`session/load`** — agent replays the full conversation history to you, then you're ready. Use this if your UI needs to reconstruct the chat.
- **`session/resume`** — agent just reconnects, no history. Use this if you already have the messages stored client-side and just need the context back.

Since you closed the session (not deleted it), the session ID `019ec838-ebd0-7410-957d-b09852e3bf9a` should still be valid. Want me to append both variants?

```json
{ "jsonrpc": "2.0", "id": 6, "method": "session/load", "params": { "sessionId": "019ec838-ebd0-7410-957d-b09852e3bf9a", "cwd": "~/libs/acp-lib", "mcpServers": [] } }
```

```json
{ "jsonrpc": "2.0", "id": 6, "method": "session/resume", "params": { "sessionId": "019ec838-ebd0-7410-957d-b09852e3bf9a", "cwd": "~/libs/acp-lib", "mcpServers": [] } }
```



## session/prompt

```json
{ "jsonrpc": "2.0", "id": 7, "method": "session/prompt", "params": { "sessionId": "019ec8fc-44d6-78d3-8d30-fa6aa4f7ef05", "prompt": [{ "type": "text", "text": "What model are you?" }] } }
```

See [this file](./test-session_prompt.md) for more tests.

{ "jsonrpc": "2.0", "id": 9, "method": "session/prompt", "params": { "sessionId": "019ec8fc-44d6-78d3-8d30-fa6aa4f7ef05", "prompt": [{ "type": "text", "text": "Without using any tools: You have a 3-gallon jug and a 5-gallon jug, no markings. How do you measure exactly 4 gallons? Now generalize: given jugs of size A and B (coprime), what quantities can you measure, and what is the minimum number of steps to measure any target T? Prove your answer." }] } }




Everything from the agent is a `session/update` notification. The only thing that varies is the `sessionUpdate` field inside:

- `agent_thought_chunk` — thinking stream
- `agent_message_chunk` — response stream
- `tool_call` / `tool_call_update` — tool activity
- `usage_update` — token counts
- `session_info_update` — session state
- `available_commands_update` — slash commands
- `plan_update` — agent plan steps

One notification type, many subtypes. The `sessionUpdate` field is the discriminator.


### plans

```json
{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":"94b5204d-7dd9-4df2-977e-cbccc99c8218","prompt":[{"type":"text","text":"Before writing any code, create a detailed plan for implementing a REST API with authentication, CRUD endpoints for users and posts, and rate limiting. List each task with its priority."}]}}
```


```json
{"jsonrpc":"2.0","id":1,"method":"session/request_permission","params":{"options":[{"kind":"allow_once","name":"Approve once","optionId":"approve"},{"kind":"allow_always","name":"Approve for this session","optionId":"approve_for_session"},{"kind":"reject_once","name":"Reject","optionId":"reject"}],"sessionId":"94b5204d-7dd9-4df2-977e-cbccc99c8218","toolCall":{"content":[{"newText":"# REST API Implementation Plan\n\n## Context\n\nImplement a standalone REST API with authentication, CRUD endpoints for **users** and **posts**, and rate limiting.\n\nThis plan assumes a new, self-contained service rather than modifying the existing ACP library module in `/workspace`. If the API should be added to the current project, the plan should be adjusted to integrate with the existing Bun/TypeScript toolchain.\n\n## Technology Choices\n\n- **Runtime:** Node.js or Bun\n- **Language:** TypeScript\n- **Framework:** Express.js or Fastify\n- **Database:** SQLite for local/dev simplicity, or PostgreSQL for production\n- **ORM:** Prisma or Drizzle\n- **Authentication:** JWT (access + refresh tokens) or session-based cookies\n- **Password hashing:** bcrypt or Argon2\n- **Rate limiting:** `express-rate-limit` (if Express) or `@fastify/rate-limit` (if Fastify)\n- **Validation:** Zod\n- **Testing:** Vitest or Jest + Supertest\n\n## Task List with Priorities\n\n### P0 \u2014 Foundation & Setup\n1. **Initialize project**\n   - Create project folder\n   - Set up `package.json`\n   - Install runtime, framework, TypeScript, and dev dependencies\n   - Configure TypeScript (`tsconfig.json`)\n   - Add ESLint + Prettier\n\n2. **Configure environment**\n   - Create `.env.example` with `PORT`, `DATABASE_URL`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `NODE_ENV`\n   - Add `.gitignore` for `node_modules`, `.env`, build output\n\n3. **Set up database**\n   - Choose and install database driver\n   - Set up ORM/schema with two tables: `User` and `Post`\n   - Run initial migration\n\n### P0 \u2014 Database Schema\n4. **Define `User` model**\n   - `id` (UUID or auto-increment)\n   - `email` (unique, indexed)\n   - `passwordHash`\n   - `name`\n   - `createdAt`, `updatedAt`\n\n5. **Define `Post` model**\n   - `id`\n   - `title`\n   - `content`\n   - `published` (boolean)\n   - `authorId` (foreign key to User)\n   - `createdAt`, `updatedAt`\n\n### P0 \u2014 Core Application Structure\n6. **Bootstrap server**\n   - Create entry point (`src/index.ts` or `src/server.ts`)\n   - Initialize framework app\n   - Load environment variables\n   - Add global middleware: JSON parser, helmet, CORS\n\n7. **Add centralized error handling**\n   - Async wrapper to catch errors\n   - Custom error classes (ValidationError, UnauthorizedError, NotFoundError)\n   - Global error middleware\n\n8. **Add request logging**\n   - Morgan or pino for HTTP request logging\n\n### P0 \u2014 Authentication\n9. **Implement password hashing utilities**\n   - `hashPassword(password)`\n   - `verifyPassword(password, hash)`\n\n10. **Implement JWT utilities**\n    - `signAccessToken(payload)` / `verifyAccessToken(token)`\n    - `signRefreshToken(payload)` / `verifyRefreshToken(token)`\n    - Token payload: `{ userId, email }`\n\n11. **Implement registration endpoint**\n    - `POST /auth/register`\n    - Validate email/password with Zod\n    - Check email uniqueness\n    - Hash password\n    - Create user\n    - Return 201 + safe user object\n\n12. **Implement login endpoint**\n    - `POST /auth/login`\n    - Validate credentials\n    - Compare password hash\n    - Issue access token (short-lived) and refresh token (long-lived)\n    - Return tokens or set HTTP-only cookies\n\n13. **Implement token refresh endpoint**\n    - `POST /auth/refresh`\n    - Accept refresh token\n    - Verify token and check against stored/allowed tokens\n    - Issue new access token\n\n14. **Implement logout endpoint**\n    - `POST /auth/logout`\n    - Invalidate refresh token (if stored server-side)\n    - Clear cookies if cookie-based\n\n15. **Implement authentication middleware**\n    - Extract access token from `Authorization: Bearer <token>` header or cookie\n    - Verify token and attach `req.user`\n    - Return 401 if missing or invalid\n\n### P0 \u2014 User CRUD\n16. **Create user**\n    - Already covered by `POST /auth/register`\n\n17. **List users**\n    - `GET /users`\n    - Return paginated list (skip/limit or cursor)\n    - Exclude `passwordHash`\n\n18. **Get user by ID**\n    - `GET /users/:id`\n    - Return safe user object\n\n19. **Update user**\n    - `PATCH /users/:id`\n    - Restrict to own profile (or admin)\n    - Allow updating `name`; optionally allow email change with re-verification\n    - Re-hash password if provided\n\n20. **Delete user**\n    - `DELETE /users/:id`\n    - Restrict to own account (or admin)\n    - Optionally cascade delete posts or reassign\n\n### P0 \u2014 Post CRUD\n21. **Create post**\n    - `POST /posts`\n    - Requires authentication\n    - Validate `title`, `content`, `published`\n    - Set `authorId` from `req.user.id`\n\n22. **List posts**\n    - `GET /posts`\n    - Public endpoint\n    - Support pagination, filtering by `published`, sorting\n\n23. **Get post by ID**\n    - `GET /posts/:id`\n    - Public for published posts; draft posts visible only to author\n\n24. **Update post**\n    - `PATCH /posts/:id`\n    - Requires authentication\n    - Restrict to author (or admin)\n    - Validate fields\n\n25. **Delete post**\n    - `DELETE /posts/:id`\n    - Requires authentication\n    - Restrict to author (or admin)\n\n### P1 \u2014 Rate Limiting & Security\n26. **Install and configure rate limiter**\n    - Global limit: e.g. 100 requests per 15 minutes per IP\n    - Stricter limits for auth endpoints: e.g. 5 attempts per 15 minutes per IP\n\n27. **Add security headers**\n    - Use helmet or equivalent\n\n28. **Input sanitization**\n    - Prevent NoSQL/SQL injection via ORM + validation\n    - Optional: strip HTML from user content\n\n29. **CORS configuration**\n    - Restrict origins in production\n\n### P1 \u2014 Testing\n30. **Unit tests for utilities**\n    - Password hashing\n    - JWT sign/verify\n    - Validation schemas\n\n31. **Integration tests for auth endpoints**\n    - Register success/failure\n    - Login success/failure\n    - Refresh/logout\n\n32. **Integration tests for user endpoints**\n    - CRUD operations with auth\n    - Authorization checks\n\n33. **Integration tests for post endpoints**\n    - CRUD operations\n    - Public vs draft visibility\n    - Authorization checks\n\n34. **Rate limiting tests**\n    - Verify global and auth-specific limits\n\n### P2 \u2014 Documentation & Polish\n35. **API documentation**\n    - Write README with endpoint list, auth flow, and example requests\n    - Optional: OpenAPI/Swagger spec\n\n36. **Health check endpoint**\n    - `GET /health` returning status and timestamp\n\n37. **Seed script**\n    - Create sample users and posts for development\n\n38. **Docker support (optional)**\n    - `Dockerfile` and `docker-compose.yml`\n\n39. **CI configuration (optional)**\n    - GitHub Actions workflow for lint/test/build\n\n## Priority Legend\n\n- **P0** \u2014 Required for a working, secure MVP\n- **P1** \u2014 Important for production readiness and robustness\n- **P2** \u2014 Nice-to-have developer experience and documentation\n\n## Suggested Implementation Order\n\n1. P0: Foundation & setup (tasks 1\u20133)\n2. P0: Database schema (tasks 4\u20135)\n3. P0: Server bootstrap & middleware (tasks 6\u20138)\n4. P0: Authentication (tasks 9\u201315)\n5. P0: User CRUD (tasks 16\u201320)\n6. P0: Post CRUD (tasks 21\u201325)\n7. P1: Rate limiting & security (tasks 26\u201329)\n8. P1: Tests (tasks 30\u201334)\n9. P2: Documentation & polish (tasks 35\u201339)","oldText":"","path":"/workspace/PLAN.md","type":"diff"}],"title":"WriteFile: PLAN.md","toolCallId":"5f08b280-5b7a-49fd-9cb7-9e6ae11a6bfa/tool_S7fV1XjygIZn01Q5gXCnlhCD"}}}
```

The flood happened because of how `tool_call_update` works: it streams the **cumulative** JSON argument so far, not just the new characters. So for a big WriteFile call:

- Update 1: `{"path": "/workspace/PLAN.md", "content": "# R`
- Update 2: `{"path": "/workspace/PLAN.md", "content": "# RE`
- Update 3: `{"path": "/workspace/PLAN.md", "content": "# RES`
- ...hundreds of times, each one repeating the whole thing

Since the file content was ~4KB of markdown, you get O(n²) total bytes in the update stream. For a 4000-char file that's potentially millions of characters across all updates combined.

Two things to note:

1. **The `session/request_permission` at the end** — the agent streamed the full tool input first, then asked for approval before actually writing. So all those updates were just the model generating the arguments, not the tool executing.

2. **For a client library**: you'd typically only care about the *final* `tool_call_update` (the one with `status: "completed"`) which has the full, stable content. All intermediate ones are just for showing live preview of what the model is typing. Most UIs would debounce or only render the latest.



### Slash Commands

Commands are just regular `session/prompt` calls where the text starts with `/`. The agent advertises available commands via `available_commands_update` after `session/new`, but invoking them is just plain text in the prompt:

```json
{"jsonrpc":"2.0","id":8,"method":"session/prompt","params":{"sessionId":"94b5204d-7dd9-4df2-977e-cbccc99c8218","prompt":[{"type":"text","text":"/compact"}]}}
```

No special method. The agent parses the `/` prefix itself and handles it internally. The `available_commands_update` is just metadata for the client to show a command palette — the actual invocation is always via `session/prompt`.



It seems that wor commands like \yolo (auto-approve) toggle the functionality, so running them enables / disables in cycles.


## session/request_permission

That's `session/request_permission` — a bidirectional request the agent sends TO the client when it wants to run something that needs approval.

The agent sends:
```json
{"jsonrpc":"2.0","id":99,"method":"session/request_permission","params":{"sessionId":"...","description":"Run command: rm -rf build/","options":[{"optionId":"allow_once","label":"Allow once"},{"optionId":"allow_session","label":"Allow for session"},{"optionId":"reject_once","label":"Reject"}]}}
```

The client must respond:
```json
{"jsonrpc":"2.0","id":99,"result":{"outcome":{"outcome":"selected","optionId":"allow_once"}}}
```

Key points:
- It has an `id` — it's a **request**, not a notification, so the client must reply
- The agent blocks until the client responds
- The options are agent-defined (not a fixed set) — `allow_once`, `allow_session`, `reject_once` are common but agents can send whatever
- In the reference library, `autoApprove` just picks the first option automatically


```json
{"jsonrpc":"2.0","id":8,"method":"session/prompt","params":{"sessionId":"94b5204d-7dd9-4df2-977e-cbccc99c8218","prompt":[{"type":"text","text":"List the files in the current directory and tell me what kind of project this is"}]}}
```

```json
{
    "jsonrpc": "2.0",
    "id": 0,
    "method": "session/request_permission",
    "params": {
        "options": [
            {
                "kind": "allow_once",
                "name": "Approve once",
                "optionId": "approve"
            },
            {
                "kind": "allow_always",
                "name": "Approve for this session",
                "optionId": "approve_for_session"
            },
            {
                "kind": "reject_once",
                "name": "Reject",
                "optionId": "reject"
            }
        ],
        "sessionId": "94b5204d-7dd9-4df2-977e-cbccc99c8218",
        "toolCall": {
            "content": [
                {
                    "content": {
                        "text": "Requesting approval to perform: Run command `ls -la`",
                        "type": "text"
                    },
                    "type": "content"
                }
            ],
            "title": "Shell: ls -la",
            "toolCallId": "53ed1bb6-eb27-4957-9c1e-82e47663e26c/tool_0Ke4FzF7kaZ88owx52UMyEVy"
        }
    }
}
```


```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "outcome": {
      "outcome": "selected",
      "optionId": "approve_for_session"
    }
  }
}
```

{ "jsonrpc": "2.0", "id": 0, "result": { "outcome": { "outcome": "selected", "optionId": "approve_for_session" } } }

Now you can see the full picture of a real turn with tool use. A few things worth noting from this response:

- **5 parallel tool calls** all fired at once: `Shell: ls -la` + 4 `ReadFile` calls (`index.ts`, `types.ts`, `providers.ts`, `client.ts`, `session.ts`)
- **`tool_call_update` streams the raw input** as it's being generated — you can watch the JSON build up character by character (`{"path": "/` → `/workspace` → `/workspace/index.ts` → `}`)
- **`status: "completed"` with file content** arrives in a single `tool_call_update` — the full file content is in the `content` field when the tool finishes
- **Second thought phase** happens after tools complete — the agent thinks again to synthesize the results before writing the response
- **`agent_thought_chunk` → `agent_message_chunk` transition** marks where thinking ends and the actual reply begins

The `toolCallId` format is `<sessionId-prefix>/tool_<randomId>` — Kimi-specific, but all correlated to the same turn.




Full response [here](./responses/response5-request).



## Id

```json
{"jsonrpc":"2.0","id":0,"method":"session/request_permission","params":{"options":[{"kind":"allow_once","name":"Approve once","optionId":"approve"},{"kind":"allow_always","name":"Approve for this session","optionId":"approve_for_session"},{"kind":"reject_once","name":"Reject","optionId":"reject"}],"sessionId":"94b5204d-7dd9-4df2-977e-cbccc99c8218","toolCall":{"content":[{"content":{"text":"Requesting approval to perform: Run command `ls -la`","type":"text"},"type":"content"}],"title":"Shell: ls -la","toolCallId":"53ed1bb6-eb27-4957-9c1e-82e47663e26c/tool_0Ke4FzF7kaZ88owx52UMyEVy"}}}

{ "jsonrpc": "2.0", "id": 2, "result": { "outcome": { "outcome": "selected", "optionId": "approve_for_session" } } }

{ "jsonrpc": "2.0", "id": 0, "result": { "outcome": { "outcome": "selected", "optionId": "approve_for_session" } } }
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"94b5204d-7dd9-4df2-977e-cbccc99c8218","update":{"content":[{"content":{"text":"{\"","type":"text"},"type":"content"}],"status":"in_progress","title":"ReadFile","toolCallId":"53ed1bb6-eb27-4957-9c1e-82e47663e26c/tool_BWvIEBCuM1MuOH8Xh9Hz8zAG","sessionUpdate":"tool_call_update"}}}
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"94b5204d-7dd9-4df2-977e-cbccc99c8218","update":{"content":[{"content":{"text":"{\"path","type":"text"},"type":"content"}],"status":"in_progress","title":"ReadFile","toolCallId":"53ed1bb6-eb27-4957-9c1e-82e47663e26c/tool_BWvIEBCuM1MuOH8Xh9Hz8zAG","sessionUpdate":"tool_call_update"}}}
```

1. Agent sends permission request with "id": 0 — blocks
2. You send "id": 2 — nothing happens (agent ignores it, can't match)
3. You send "id": 0 — agent responds instantly


Yes, the `id` matters — but only in a specific way.

**JSON-RPC `id` semantics:**
- The value itself is arbitrary (0, 1, "abc" — all fine)
- What matters is that the **response `id` must match the request `id`** exactly, so the sender can correlate response to request

In the ACP flow you saw:
- `session/request_permission` came with `"id": 0` — the agent is blocking waiting for a response
- Your response needed `"id": 0` back, otherwise the agent can't match it and will hang (or error)

**For the SDK:** The `ClientSideConnection` handles this for you — when you return from `requestPermission()`, the SDK wraps your return value in `{"jsonrpc":"2.0","id":<same-id>,"result":{...}}` automatically. You never see the id.

**For raw JSON-RPC (manual testing):** You need to echo the exact same id. That's why in your raw session you used `"id": 2` on the response — matching whatever `id` the agent sent in the permission request.

**Notifications have no `id`:** `session/update` events have no `id` field because they're fire-and-forget — no response expected, nothing to correlate.

So: the value doesn't matter, but the echo does.




## Traceability

you can reconstruct a complete audit trail per turn:

- **Who**: `sessionId` + agent identity from `initialize`
- **What they thought**: `agent_thought_chunk` stream
- **What they decided to do**: `tool_call` with the streamed raw input
- **What was approved**: `session/request_permission` + the client's response (`optionId`)
- **What happened**: `tool_call_update` status progression (`in_progress` → `completed`/`failed`)
- **What they said**: `agent_message_chunk` stream
- **What it cost**: `usage_update` + final usage

All correlated by `toolCallId` and `sessionId`. Timestamps are trivially added client-side at the moment each notification arrives.

This is actually a strong argument for the library exposing a structured event log per turn, not just the final text — the raw event stream is far more valuable than just the response.



## session/set_config_option

```json
{ "jsonrpc": "2.0", "id": 8, "method": "session/set_config_option", "params": { "sessionId": "019ec8fc-44d6-78d3-8d30-fa6aa4f7ef05", "configId": "reasoning_effort", "value": "xhigh" } }

{"jsonrpc":"2.0","id":8,"result":{"configOptions":[{"id":"mode","name":"Mode","description":"Approval and sandboxing preset for the session","category":"mode","type":"select","currentValue":"agent","options":[{"value":"read-only","name":"Read-only","description":"Requires approval to edit files and run commands."},{"value":"agent","name":"Agent","description":"Read and edit files, and run commands."},{"value":"agent-full-access","name":"Agent (full access)","description":"Codex can edit files outside this workspace and run commands with network access. Exercise caution when using."}]},{"id":"model","name":"Model","description":"Model Codex uses for the session","category":"model","type":"select","currentValue":"gpt-5.5","options":[{"value":"gpt-5.5","name":"GPT-5.5","description":"Frontier model for complex coding, research, and real-world work."},{"value":"gpt-5.4","name":"GPT-5.4","description":"Strong model for everyday coding."},{"value":"gpt-5.4-mini","name":"GPT-5.4-Mini","description":"Small, fast, and cost-efficient model for simpler coding tasks."}]},{"id":"reasoning_effort","name":"Reasoning effort","description":"How much reasoning effort the model should use","category":"thought_level","type":"select","currentValue":"xhigh","options":[{"value":"low","name":"low","description":"Fast responses with lighter reasoning"},{"value":"medium","name":"medium","description":"Balances speed and reasoning depth for everyday tasks"},{"value":"high","name":"high","description":"Greater reasoning depth for complex problems"},{"value":"xhigh","name":"xhigh","description":"Extra high reasoning depth for complex problems"}]},{"id":"fast-mode","name":"Fast mode","description":"1.5x speed, increased usage","category":"fast-mode","type":"select","currentValue":"off","options":[{"value":"off","name":"Off","description":"Default speed, normal usage"},{"value":"on","name":"On","description":"1.5x speed, increased usage"}]}]}}
```

```json
{"jsonrpc":"2.0","id":5,"method":"session/set_config_option","params":{"sessionId":"019ec8dc-99a8-7771-bb95-2638dda83dba","configId":"model","value":"gpt-5.5"}}
```





```json
{ "jsonrpc": "2.0", "id": 2, "method": "session/list", "params": { "cwd": "~/libs/acp-lib" } }
```

```json
{ "jsonrpc": "2.0", "id": 2, "method": "session/delete", "params": { "sessionId": "019ec8fc-44d6-78d3-8d30-fa6aa4f7ef05" } }
```










```json
{ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": 1, "capabilities": { "fs": { "readTextFile": true, "writeTextFile": true }, "terminal": true }, "clientInfo": { "name": "acp-lib", "title": "ACP Lib", "version": "0.1.0" } } }



{ "jsonrpc": "2.0", "id": 2, "method": "authenticate", "params": { "methodId": "login" } }


{ "jsonrpc": "2.0", "id": 4, "method": "session/new", "params": { "cwd": "/workspace", "mcpServers": [] } }


{ "jsonrpc": "2.0", "id": 8, "method": "session/set_config_option", "params": { "sessionId": "cc8795a7-b0ac-4f97-af9c-c48142b1e3bf", "configId": "reasoning_effort", "value": "xhigh" } }


{ "jsonrpc": "2.0", "id": 7, "method": "session/prompt", "params": { "sessionId": "94b5204d-7dd9-4df2-977e-cbccc99c8218", "prompt": [{ "type": "text", "text": "What model are you,? change every letter for a number" }] } }




```
## 2026-06-15 — degraded mode PTY transport decision

- **node-pty under Bun is unusable**: even a plain `bash --norc -i` child dies
  immediately with `EXIT {exitCode:0, signal:1}` (SIGHUP); `onData` never fires.
  This is broader than the earlier bun-in-bun quirk — the read path itself is broken.
  (Native module also has to be hand-copied into Bun's global cache to even load:
  `node_modules/node-pty/build/Release/pty.node` → `~/.bun/install/cache/node-pty@.../build/Release/`.)
- **Chosen transport: `script` (util-linux) owns the pty; we drive plain Bun.spawn pipes.**
  `script -qfec "<cmd>" /dev/null` with `TERM=xterm-color`, stdin via TransformStream,
  stdout piped. Smoke test (interactive bash):
    `echo HELLO_$((6*7))` → captured `bash-5.1# echo ...\nHELLO_42\nbash-5.1# ` (RAW_LEN 76, match ✓).
  Same pipe mechanism as AcpTransport, zero native deps. macOS variant differs
  (`script -q /dev/null cmd args`) — Linux handled first.

## 2026-06-15 — degraded mode wired end-to-end

Architecture landed: `AcpController` → **`AgentController`** (mode-agnostic); new
`mode: "normal" | "degraded"` dimension orthogonal to `adapter`; PtyClient is a sibling
leaf to AcpClient (both implement AgentClient), constructed by `bringUp()` via dynamic
import so normal mode never loads the degraded subpath. `setMode()` degrades/upgrades in
place. Adapter presets gained `ptyCommand` (interactive CLI for pty mode).

- **PtyClient vs bash** (`echo HELLO_$((6*7))`): text `"HELLO_42"`, multi-line `"a\nb\nc"`,
  status completed. Echo + trailing-prompt stripped. (Streaming onChunk still includes the
  trailing prompt chrome mid-stream — final text is clean; naive limitation.)
- **AgentController degraded** (bash adapter): start `{sessionId:"",resumed:false}`,
  prompt streams `"CONTROLLER_OK"`, `capabilities` throws as designed, `getCommands`
  reports caps/sessions/config/load/resume/fork unavailable, session/switch available.
- node-pty removed from package.json. New runtime dep: system `script` (util-linux).
- NOT yet tested against a real agent TUI (codex interactive) — naive ANSI-strip on a
  full-screen TUI will be messy and is the next validation.

## 2026-06-15 — switched PTY transport to Bun's native terminal API

Bun ≥ 1.3.5 has a built-in pty: `Bun.spawn(cmd, { terminal: { cols, rows, data } })`,
with `proc.terminal.write/resize/setRawMode` + termios flags. Verified against bash:
RAW_LEN 76, HAS_42 true, identical capture to the `script` approach. Replaced
PtyTransport's `script` wrapper with the native API — no external `script` binary, real
resize() for TUIs, command spawned as argv directly (no shell quoting). PtyClient gained
resize(cols, rows).

## 2026-06-15 — real codex TUI in degraded mode (naive path)

Pointed `mode: degraded` at the actual `codex` interactive CLI. Findings:
- **codex does NOT use the alt-screen** (no `\x1b[?1049h`) — it redraws in place with
  cursor positioning + boxes.
- **Submit needs a separate Enter**: `write("hello\r")` in ONE call typed `hello` into the
  box but did NOT submit (treated as paste). Fix: `write(text)`, wait ~150ms,
  `write("\r")` separately → turn fires, codex answered `• 42` to "what is 6×7". Landed as
  PtyClient `submitDelayMs` (default 150) + split write.
- **Naive strip is unusable on a redraw TUI**: cleaned output is overlapping mush
  (`Booti…Bng`, interleaved boxes). The answer "42" is present but buried. Confirms the
  SPEC "emulate, don't strip" requirement — TUIs need a grid emulator + segmentation, not
  ANSI stripping. Naive path remains fine for line-oriented CLIs (bash/REPLs).

## 2026-06-15 — Option 2 (emulator pipeline) WORKS against real codex TUI

Built the full deterministic pipeline: raw bytes → EmulatorScreen (@xterm/headless grid)
→ settle → extractReply. @xterm/headless renders codex's redraw-in-place screen perfectly
under Bun (clean box + "› prompt" + "• 42"), vs strip-garbage.

- **Offline** (captured codex turn → /tmp/codex-raw.bin): extractReply → "42".
- **Live via AgentController** (mode degraded, adapter codex): "what is 6×7" → "42",
  "now multiply that by 2" → "84" — MULTI-TURN CONTEXT PRESERVED.
- **Live via CLI** (`chat --adapter codex --degraded`, piped): "capital of France" →
  "Paris", clean exit 0.
- **bash** (line CLI) through the same emulator path: "HELLO_42", "a\nb\nc" (trailing
  shell prompt stripped by extractReply's SHELL_PROMPT stop).
- **Exit hang fixed**: native pty `terminal` handle keeps Bun's loop alive → stop() now
  `terminal.close()` + SIGKILL after 500ms grace.

extractReply = deterministic default (anchor on echoed prompt → lines until next
input/status/shell-prompt chrome, strip bullets). Injectable ScreenParser (SML) is the
upgrade seam. TODO: incremental streaming (reply currently emitted once on settle),
provider coverage, SML parser.

## 2026-06-15 — ACP /login (authenticate) round

Auth state is OPAQUE (kimi answers {} then empties every turn; can't discriminate
authed/unauthed). So: one uniform flow, /login available anytime when connected.

- `AcpClient`: `authMethods` getter, `authenticate(methodId, {onOutput})` (connection-level,
  tees agent stderr → onOutput so login URL/device-code shows), `newSession()` (forced fresh).
- `AgentController`: same surface; `login`/`new` in command registry (gated to ACP mode).
- `bringUp`: `startSession()` failure is now NON-FATAL — keep the connection so the user can
  /login then /new. connect() stays fatal.
- `AuthMethod` type added (no SDK leak); empty-turn REPL hint now points at /login.

Verified against real codex-acp:
- `/login` → lists `api-key (API Key)`, `chat-gpt (ChatGPT)`. ✓
- `/help` shows `/login [METHOD] /new`. ✓  `/new` → fresh session id. ✓
- degraded `/login` → guarded ("bridge not built yet"). ✓
- Did NOT trigger `/login chat-gpt` (codex already authed; would launch browser/device flow).

## 2026-06-15 — /bridge (terminal passthrough) + auth stderr filter

- `isRpcNoise` filter: during /login the agent's stderr is teed to show login URLs, but
  raw JSON-RPC error dumps (codex's `Error handling request {…}` on api-key failure) are
  now suppressed — we report the error ourselves. (api-key over ACP: schema is just
  `{methodId}`, no credential field; codex rejects it -32600. It's env/out-of-band, like
  kimi's terminal method — informational.)
- **Bridge**: `Bridgeable`/`BridgeOptions` interface; `PtyClient.bridge()` mirrors the pty
  to the user (rawListeners → output) and forwards keystrokes (writeBytes) until Ctrl-]
  (0x1d). SIGWINCH nudge forces a repaint on entry. `AgentController.bridge()` (degraded-
  only) + CLI `/bridge`. The tty-auth path + escape hatch for unreadable TUIs (the /d case).
- Verified with synthetic streams vs bash: banner shown, `echo BRIDGED_9` mirrored back,
  Ctrl-] exits + resolves cleanly. Normal-mode /bridge guarded. Typecheck clean.

## 2026-06-15 — bridge fixes (repaint, exit, both modes)

Feedback from live codex /bridge: didn't repaint, Ctrl-] didn't exit, Ctrl-C hung. Fixes:
- **Exit**: now exits on Ctrl-] (0x1d) OR Ctrl-C (0x03) — `exitBytes` set. Kills the hang
  (raw mode disables ISIG, so Ctrl-C was being forwarded to codex forever). codex
  interrupts with ESC, not Ctrl-C, so nothing lost. Forward bytes up to the exit byte.
- **Repaint**: SIGWINCH nudge was unreliable; instead dump the current emulated screen
  (clear + readScreen view) on entry, and clear screen on exit so the REPL returns clean.
- **Both modes**: `AgentController.bridge()` now works in normal mode too — spins up an
  EPHEMERAL interactive pty (adapter.ptyCommand), bridges it, tears it down; ACP session
  untouched. Degraded mode still bridges the LIVE pty (same conversation). CLI guard removed.
- Verified synthetic (bash): input forwarded, output mirrored (BRIDGED_9), Ctrl-C exits.
  Real-terminal codex test still pending (needs a TTY; harness can't drive it).

## 2026-06-15 — bridge sizing + slash-command crash guard

Live feedback: (a) /load on an empty codex session → `-32603 "no rollout found"` CRASHED
the REPL (unhandled rejection); (b) Claude Code TUI rendered garbled through the bridge.

- **Crash guard**: repl.ts now wraps `onSlashCommand` in try/catch → "(/load failed: …)"
  instead of killing the process. Covers load/resume/fork/sessions/config/switch. (The
  codex error is expected: a freshly-created session has no persisted rollout to load;
  loading one WITH history works — verified, 你好 conversation replayed fine.)
- **Bridge sizing**: the pty was fixed 100×30 but the user's terminal differs → TUI
  mis-wraps. bridge() now resizes the pty+emulator to the REAL terminal size
  (output.columns/rows) on entry (SIGWINCH → clean full repaint) and tracks live
  `resize` events. Dropped the entry screen-dump (it overlapped full-TUI repaints —
  the Claude garble). Clear on entry + exit.
- Going back and forth bridge↔REPL keeps context (confirmed by user). Real-terminal
  Claude/codex render test still pending (harness has no TTY).

## 2026-06-15 — command namespacing: `/` ours, `//` agent

Three command sources were colliding (consumer / acp-lib native / agent). Native shadowed
agent commands of the same name (kimi /sessions unreachable). Resolution:
- **`//name` = verbatim agent passthrough** (repl.ts): sends `/name` to the agent as a
  prompt, bypassing our handlers. Escape hatch for clashes (//sessions → kimi's).
- **Agent commands surfaced**: AcpClient captures `available_commands_update` →
  `agentCommands` getter; controller exposes it; `/help` lists them ("send with //name").
  `AgentCommand` type added + exported.
- Verified vs codex: `available_commands_update` arrives AFTER the first turn (not at
  session/new), so /help shows agent cmds once a turn has happened — mcp, skills, status,
  logout, $figma:*, etc. `//name` forwards correctly. Typecheck clean.
- Plain `/foo` unchanged: native first, else fall through to agent. Degraded: `//name`
  types /name into the TUI (may open a modal → pair with /bridge).

## 2026-06-15 — /sessions empty on kimi: explicit-null cwd filter

`/sessions` returned "(no sessions)" on (newly-upgraded) kimi, but works on codex.
Root cause candidate: we sent `cwd: null` + `cursor: null` explicitly. Per schema cwd is
an optional FILTER ("Filter sessions by working directory"); an explicit null can be read
as "sessions whose cwd is null" → empty, vs OMITTING = no filter = all. codex tolerates
null and returns all; kimi may not. Fix: build the request omitting cwd/cursor unless set.
- codex regression check: still lists all 26 sessions. Typecheck clean.
- kimi unverifiable locally (not installed) — needs user retest; if still empty, capture
  `--debug` list_sessions_response to see if kimi returns [] (migration/upgrade) or a
  different shape (parser).

## 2026-06-15 — step 1: session storage layer (catalog)

New top-level abstraction groundwork. Decided: AgentSession (front face) → AgentController
(single-adapter, live) → leaves; SessionManager catalog on the side. This step = storage only.

- `SessionStore` interface (save/get/list/delete) — pluggable so the hub can back it with
  its DB. Default `FileSessionStore` (file-per-session JSON under sessionsDir, default
  ~/.acp-lib/sessions, overridable). `defaultSessionsDir()` exported.
- `SessionRecord`: OUR stable `id` (catalog key) decoupled from mutable `agentSessionId`
  (null in degraded, changes on mode-swap) + adapter/mode/cwd/title/timestamps. Routing
  metadata only — NOT transcript content (agent owns that; slot left to add later).
- `SessionManager`: upsert (createdAt preserved, updatedAt bumped), get/delete/list, and
  `listMerged()` / pure `mergeSessions()` — merges catalog with the agent's live list
  (source: catalog | agent | both), so a broken kimi list doesn't blind us and external
  (CLI/bridge) sessions still show.
- Removed old standalone sessions.ts. Typecheck clean. Verified CRUD + all 3 merge cases.
- NOT wired into AgentSession/CLI yet (review storage in isolation first).

## 2026-06-15 — step 2: AgentSession (the front face)

`AgentSession` = durable conversation + library front face. Implements AgentClient (REPL
can prompt it), holds an AgentController for the live connection, owns identity, persists
to SessionManager. Adapter lives here (switch = new session).

- `create(config)` mints our stable `id` (or resumes when `id`+`agentSessionId` passed);
  `prompt` auto-derives title from first message, tracks lazy agentSessionId, persists.
  `setMode` swaps degrade/upgrade + updates agentSessionId. `connection` getter = escape
  hatch to the controller (config/caps/login). `listSessions()` returns the MERGED view.
- Built on the current (multi-adapter) controller via a single-entry adapters map — step 3
  will simplify the controller to single-adapter underneath.
- Verified vs real codex: create → our-id ≠ agentSessionId; prompt → title + catalog write;
  merged list shows our session as `both` among 25; RESUME from record → same our-id, agent
  session loaded, remembered "11" (context preserved). Typecheck clean.

## 2026-06-15 — step 3: AgentController is now single-adapter

"Switch adapter = new AgentSession", so the controller no longer multiplexes adapters.
- Config: `adapters` map + `initialAdapter` → `adapter: Adapter` + `adapterId: string`.
- Removed: `switchAdapter`, `SwitchAdapterResult`, `adapterIds`, `hasAdapter`,
  `requireAdapter`, the `switch` command. `bringUp(mode, sessionId?)` (no adapterId).
- AgentSession now builds the controller with the clean single-adapter config (dropped the
  temporary single-entry map). CLI: single-adapter construction, `/switch` removed.
- Verified: codex CLI prompts + /help (no /switch); degraded controller (bash) prompts
  "STEP3_OK"; storage tests pass. Typecheck clean.
- Mode-swap (degrade/upgrade) stays on the controller; adapter is fixed per controller.
