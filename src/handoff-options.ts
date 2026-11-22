import type { HandoffOptions } from "./agent-conversation-contracts.ts";

/** Capture handoff options when the operation enters the queue. */
export function ownHandoffOptions(options: HandoffOptions): HandoffOptions {
  return Object.freeze({
    ...(options.summary === undefined ? {} : { summary: options.summary }),
    ...(options.target === undefined
      ? {}
      : {
          target: Object.freeze({
            adapterId: options.target.adapterId,
            ...(options.target.mode === undefined ? {} : { mode: options.target.mode }),
            ...(options.target.adapter === undefined
              ? {}
              : {
                  adapter: Object.freeze({
                    ...(options.target.adapter.cancelGraceMs === undefined
                      ? {}
                      : { cancelGraceMs: options.target.adapter.cancelGraceMs }),
                    ...options.target.adapter,
                    command: Object.freeze([...options.target.adapter.command]) as unknown as string[],
                    ...(options.target.adapter.ptyCommand
                      ? {
                          ptyCommand: Object.freeze([
                            ...options.target.adapter.ptyCommand,
                          ]) as unknown as string[],
                        }
                      : {}),
                  }),
                }),
            ...(options.target.config === undefined
              ? {}
              : { config: Object.freeze({ ...options.target.config }) }),
          }),
        }),
    ...(options.continuation === undefined
      ? {}
      : { continuation: Object.freeze({ ...options.continuation }) }),
    ...(options.targetPrompt === undefined ? {} : { targetPrompt: options.targetPrompt }),
  });
}
