A library to allow communication with agents that support the ACP protocol, and other models, by invoking their tool as a PTY terminal and parsing it.




ACP communication with agents, 

Library to communicate with agents.

The initial goal o


ACP communication with agents with fallback.

Library to communicate with agents via ACP, allowing for fallback.


A library to allow communication with agents that support the ACP protocol, and other models, by invoking their tool as a PTY terminal and parsing it.

Traditionally the problem with parsing 
Traditionally the problem with parsing was that it is quite brittle and it does not allow for 

The reason to 

Parsing 


ACP communication is pretty supported by most models, but there are a few model providers that don't support it 



A library to allow communication with agents that support the ACP protocol, and other models, by invoking their tool as a PTY terminal and parsing it.

The idea of this library was first to provide a different implementation of a model-agnostic ACP client. There are other libraries, but they put hard constraints on configs like `cwd`.
This is specially relevant if we want to talk to agents in different environments, like docker or runtime.

This library was built from a necessity to talking with multiple models, allowing for easy switching of providers. The focus was not in switching seamlessly, but simply making selection of providers a very fluent experience.
However, ACP is not implemented equally by all providers. In particular, there are two problems:
- Some providers don't support certain crucial operations, like `/login`
- Some providers make SDK usage non-subscription based.

Since ACP implementations often make use of SDK, the second point effectively means making subscriptions not able to work with ACP clients.

For these cases, the tool has a second mode: `degraded`.
This mode, as the name implies, is a degraded version of the overall experience.
This mode uses the native tool, and parses it. It is expected to work worse than the main method of communication.


The library also provides an interactive REPL session that can be invoked programmatically or via the cli (which is a thin wrapper over the library).
The REPL 





## CLI

A basic cli is offered. This is a thin layer over the library.

It is also provided a REPL session, which can be imported and used in the program that uses this library.

# Basic usage

No matter the mode, 

There are three main methods:
- `prompt(text)`
- `interrupt()`
- `stop()`

These will work no matter the mode.

Basic usage:

```ts
import {
  AgentController,
  ADAPTERS,
  createConsoleLogger,
} from "./src/index.ts";


const controller = new AgentController({
  adapters: ADAPTERS,
  initialAdapter: "codex",
  cwd: process.cwd(),
  defaultPermission: "cancel",
  logger: createConsoleLogger({ minLevel: "info" }),
});
```

Then you can simply talk to it

```ts
const { sessionId } = await controller.start()
console.log("session", sessionId)

const result = await controller.prompt("Say hello in one sentence.")
console.log(result.text)

await controller.stop()
```

Or start a REPL session:

```ts
import { runRepl } from "./src/cli/repl.ts";

// ...

const { sessionId, resumed } = await controller.start();

try {
  await runRepl(controller, {
    intro: `${resumed ? "resumed" : "new"} session ${sessionId} (${controller.currentAdapterId})`,
    activity: true,
    spinner: true,
  });
} finally {
  await controller.stop();
}
```






# Basic Architecture:

TBI:
- AgentSession
- SessionManager

---

The current entry point is AgentController. This manages the entire logic of a single agent.

It supports