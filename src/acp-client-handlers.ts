import type * as schema from "@agentclientprotocol/sdk";
import type { TerminalHandlers } from "./transport/acp-transport.ts";
import type { ClientCapabilityConfig } from "./capabilities.ts";

export interface FilesystemHandlers {
  readTextFile?: (
    params: schema.ReadTextFileRequest,
  ) => Promise<schema.ReadTextFileResponse>;
  writeTextFile?: (
    params: schema.WriteTextFileRequest,
  ) => Promise<schema.WriteTextFileResponse>;
}

export interface AcpClientHandlers {
  terminal?: TerminalHandlers | false;
  filesystem?: FilesystemHandlers | false;
}

export interface ResolvedClientHandlers {
  terminal: "builtin" | TerminalHandlers | false;
  readTextFile: "builtin" | NonNullable<FilesystemHandlers["readTextFile"]> | false;
  writeTextFile: "builtin" | NonNullable<FilesystemHandlers["writeTextFile"]> | false;
}

export function resolveClientHandlers(
  handlers: AcpClientHandlers | undefined,
  legacy: ClientCapabilityConfig | undefined,
): ResolvedClientHandlers {
  const terminal = handlers?.terminal !== undefined
    ? handlers.terminal
    : legacy?.terminal === false ? false : "builtin";

  if (handlers?.filesystem === false) {
    return { terminal, readTextFile: false, writeTextFile: false };
  }
  if (handlers?.filesystem) {
    return {
      terminal,
      readTextFile: handlers.filesystem.readTextFile ?? false,
      writeTextFile: handlers.filesystem.writeTextFile ?? false,
    };
  }
  return {
    terminal,
    readTextFile: legacy?.fs?.readTextFile === false ? false : "builtin",
    writeTextFile: legacy?.fs?.writeTextFile === false ? false : "builtin",
  };
}
