import { testEcho, testEchoDefinition } from "./test-echo.ts";
import { testWait, testWaitDefinition } from "./test-wait.ts";
import { testFail, testFailDefinition } from "./test-fail.ts";

export const debugToolDefinitions = [testEchoDefinition, testWaitDefinition, testFailDefinition];

export const debugToolHandlers = new Map([
  [testEchoDefinition.name, testEcho],
  [testWaitDefinition.name, testWait],
  [testFailDefinition.name, testFail],
]);

export { testEcho, testEchoDefinition, testWait, testWaitDefinition, testFail, testFailDefinition };
