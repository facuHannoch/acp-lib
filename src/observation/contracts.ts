export type Listener<TEvent> = (event: TEvent) => void;
export type Unsubscribe = () => void;

export interface Subscribable<TEvent> {
  subscribe(listener: Listener<TEvent>): Unsubscribe;
}

export interface StatefulSubscribable<TSnapshot, TEvent> extends Subscribable<TEvent> {
  readonly snapshot: TSnapshot;
}
