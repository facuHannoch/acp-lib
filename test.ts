// import {
//   AcpClient,
//   AgentController,
//   ADAPTERS,
//   createConsoleLogger,
// } from "./src/index";


// const controller = new AgentController({
//     adapters: ADAPTERS,
//     initialAdapter: 'codex',
//     cwd: process.cwd(),
//     defaultPermission: "approve",
//     logger: createConsoleLogger({ minLevel: "info" })
// })

// const { sessionId } = await controller.start()
// console.log("session", sessionId)

// const result = await controller.prompt("Say hello in one sentence.")
// console.log(result.text)

// await controller.stop()







// import { AgentController, ADAPTERS } from "./src/index";


// const controller = new AgentController({
//     adapters: ADAPTERS,
//     initialAdapter: 'codex',
//     cwd: process.cwd(),
// })

// const { sessionId } = await controller.start()
// console.log("session", sessionId)

// const result = await controller.prompt("Say hello in one sentence.")
// console.log(result.text)

// await controller.stop()



// Run REPL session


import {
  AgentController,
  ADAPTERS,
  createConsoleLogger,
} from "./src/index.ts";
import { runRepl } from "./src/cli/repl.ts";

const controller = new AgentController({
  adapters: ADAPTERS,
  initialAdapter: "codex",
  // cwd: process.cwd(),
  cwd: "/workspace",
  execPrefix: ["docker", "exec", "-i", "-u", "devuser", "-w", "/workspace", "agents-atlas-a-d2e4b5"],
  defaultPermission: "cancel",
  logger: createConsoleLogger({ minLevel: "debug" }),
});

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