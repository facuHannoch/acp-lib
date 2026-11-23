/** Used when the delegation route installs the worker send operation. */
export const WORKER_SEND_DESCRIPTION = [
  "Send work to a worker. Use about to give the worker a short label for check and list.",
  'A busy send continues its running assignment by default. Set assignment to "new" to interrupt that assignment and start a separate one.',
  "Set redirect to true to take over work from another conversation when policy permits.",
  "Returns immediately without waiting for the worker's reply.",
  '"sent" means work was accepted for a new run (with a handle when opening).',
  '"steered" means a busy worker accepted the input.',
  '"busy" means nothing was sent or queued.',
  '"no_worker_free" means no slot is available and nothing was sent or queued.',
].join(" ");
