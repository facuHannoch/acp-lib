/** Validated timeline query. The optional channel narrows session visibility. */
export interface TimelineSearch {
  query: string;
  channel?: string;
  match?: "keywords" | "phrase";
  case_sensitive?: boolean;
}

export interface RetrievedMessage {
  seq: number;
  message_id: string;
  channel: string;
  sender: string;
  at?: string;
  text: string;
}

export interface TimelineHit extends Omit<RetrievedMessage, "text"> {
  excerpt: string;
}

export interface TimelineSearchResult {
  hits: TimelineHit[];
  partial: boolean;
}

export interface TimelineWindow {
  message_id: string;
  before?: number;
  after?: number;
  cursor?: string;
}

export interface TimelineWindowResult {
  target: string;
  sequence: number;
  revision: number;
  messages: Array<Omit<RetrievedMessage, "text"> & { text: string; offset: number }>;
  next?: string;
}
