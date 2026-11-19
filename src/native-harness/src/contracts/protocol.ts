import type { ChannelEvent } from "./events.ts";

export interface Subscription { text: "final"; tools: "none" | "summary" | "full" }
export interface InitializeParams {
  protocolVersion: number;
  host: { name: string; version: string };
  callbacks: string[];
  subscription: Subscription;
}
export interface ProtocolConfig {
  version: 1;
  system: string;
  model: { protocol: "scripted"; script: string };
}
export interface CreateParams {
  sessionId: string;
  config: ProtocolConfig;
  participants: { id: string; kind: "person" | "agent" | "worker" | "host" }[];
  channels: Record<string, never>;
}
export interface PushParams {
  channel: string;
  item: { id: string; kind: "user_message"; sender: string; content: { type: "text"; text: string }[]; delivery?: "queue"; wake?: true };
}
export interface Description {
  configOptions: unknown[]; commands: unknown[]; policies: string[];
  capabilities: { experimental: true; acceptance: "memory"; methods: string[]; events: string[]; persistence: false };
}
export interface Methods {
  initialize: { params: InitializeParams; result: { protocolVersion: 1; harness: { version: string }; description: Description } };
  "session/create": { params: CreateParams; result: { sessionId: string } };
  "channel/push": { params: PushParams; result: { accepted: true } };
  "session/idle": { params: Record<string, never>; result: { idle: boolean } };
}
export interface RpcRequest { jsonrpc: "2.0"; id: number; method: string; params: unknown }
export type RpcResponse = { jsonrpc: "2.0"; id: number; result: unknown } |
  { jsonrpc: "2.0"; id: number | null; error: { code: number; message: string; data: { code: string } } };
export interface RpcNotification { jsonrpc: "2.0"; method: "channel/event"; params: ChannelEvent }
/** Transport carries envelopes; client owns correlation and request timeouts. */
export interface ClientTransport {
  send(request: RpcRequest): void;
  subscribe(listener: (message: RpcResponse | RpcNotification) => void): () => void;
  onClose(listener: (error?: Error) => void): () => void;
  close(): void;
}

/** Host owns process creation and termination; transport owns protocol IO only. */
export interface StdioConnection {
  readable: ReadableStream<Uint8Array>;
  write(bytes: Uint8Array): Promise<void>;
  end(): void | Promise<void>;
  exited?: Promise<number>;
}
export interface ProtocolEndpoint {
  request(request: RpcRequest): Promise<RpcResponse>;
  subscribe(listener: (notification: RpcNotification) => void): () => void;
}
