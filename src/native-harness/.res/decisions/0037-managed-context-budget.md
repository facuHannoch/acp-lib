# 0037 · Managed model context budget

The default inference allowance is 13,312 serialized UTF-8 bytes. Managed
deployments need a way to fit a larger complete tool offer while retaining
bounded input and predictable overflow. Configure the selected model through
the existing managed config and archive path.

- OpenRouter and OpenAI-compatible models accept optional `contextBudget`.
  The window and output limits are positive safe integers. The estimation
  margin is a nonnegative safe integer. A positive input allowance is required.
- The effective output reserve is the greater of the explicit reserve and the
  output cap. With neither supplied it is 2,048. The default estimation margin
  is 1,024. The independent request cap defaults to 64 MiB and can be lowered
  to any positive integer number of bytes.
- Size the Chat Completions wire JSON with the `chat-completions-utf8-v1`
  fallback. Charge one estimated token per serialized byte excluding image
  data URLs, with 4,096 additional estimated tokens per active image. Count
  the full encoded URLs for the byte cap. This heuristic cannot predict a
  provider's tokenizer or image accounting.
- An explicit output cap maps to OpenRouter `max_tokens` or compatible
  `max_completion_tokens`. Configure the cap only for endpoints that honor
  that field. Provider rejections propagate as failures. An endpoint that
  silently ignores fields cannot be detected via Chat Completions.
- Keep the full policy-filtered offer and required context. Storage bounds
  are independent. Configured overflow reports its limit and safe numeric
  diagnostics. Explicit upstream context rejections are terminal for the
  call. A failed turn leaves the channel usable.
- Omitted profiles preserve legacy fitting and wire settings. Profile
  values are portable config. The effective config on executable open applies
  at each new inference, including after checkpoint resume. Retries keep the
  same request. Checkpoint identity and archive and storage version numbers
  stay the same. Older strict config readers refuse an explicit profile.
