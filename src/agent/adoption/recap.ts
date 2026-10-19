/**
 * The question a recap asks the model about its own history. It is sent as a hidden turn on the adopted
 * session, so the model answers from the history it already holds, however long it is; what to keep and
 * what to drop is its decision.
 */
export const RECAP_INSTRUCTION = [
  "This is an automated request to summarize this conversation for the memory of the agent that now owns it.",
  "Do not run commands, use tools, or modify any files.",
  "Write a self-contained summary of the conversation so far: what the user is trying to achieve, what has been decided,",
  "what has been done and what state things are in, any open tasks or questions, and key facts that would be needed",
  "to continue the work. Keep it as short as it can be while keeping those.",
].join(" ");

/** Marks the assistant message that holds a recap, so a reader can tell it from something the model said. */
export const RECAP_ORIGIN = "adoption_recap";
