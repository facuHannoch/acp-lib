# Inference inspection

The development inspector needs immutable snapshots of actual inference requests,
not reconstructed history. Add an optional OpenRouter request observer called
with the serialized request body before fetch. It receives no authorization
headers. The model and turn contracts stay unchanged.

Composition at the CLI observes channel submissions, turns, model responses and
tool results. Inspection state and the read-only HTTP/SSE UI live under
`src/interfaces/inspector/`, outside the kernel and model context. SSE sends full
snapshots on connection and updates, allowing refresh and reconnect without event
replay. Inspection data is in memory for this learning increment.

The observer is optional and existing adapter callers remain compatible.
