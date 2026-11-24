import type { AttachmentMetadata, InputPart } from "../../contracts/attachments.ts";
import type { StoredItem } from "../../contracts/storage.ts";

type Row = { metadata: AttachmentMetadata; readyAt: string };
export interface MemoryAttachmentState {
  base?: 6 | 7 | 8;
  files: Map<string, Row>;
  parts: Map<string, InputPart[]>;
  links: Map<string, Set<string>>;
}
export const emptyMemoryAttachments = (): MemoryAttachmentState => ({ files: new Map(), parts: new Map(), links: new Map() });

/** Metadata-only memory tables use the engine's undo log, exactly like the
 * SQLite owner transaction. Byte retention belongs to the configured root. */
export function memoryAttachmentTables(state: MemoryAttachmentState, log: (undo: () => void) => void,
  format: () => number, item: (id: string) => StoredItem | undefined) {
  const copy = <T>(value: T): T => structuredClone(value);
  const put = <K, V>(map: Map<K, V>, key: K, value: V) => {
    const had = map.has(key), old = map.get(key);
    log(() => { if (had) map.set(key, old!); else map.delete(key); });
    map.set(key, copy(value));
  };
  const setBase = (base: 6 | 7 | 8) => { const old = state.base; log(() => { state.base = old; }); state.base = base; };
  return {
    baseFormat: () => state.base,
    advanceBaseFormat(value: number) { if (state.base !== undefined && value > state.base && (value === 7 || value === 8)) setBase(value); },
    hasRetained: () => [...state.links.values()].some(links => links.size > 0),
    readyIds: () => [...state.files.keys()].sort(),
    retained: () => [...state.files.values()].filter(row => (state.links.get(row.metadata.id)?.size ?? 0) > 0).sort((a, b) => a.metadata.id.localeCompare(b.metadata.id)).map(copy),
    restore(base: 6 | 7 | 8, records: readonly Row[]) { setBase(base); for (const record of records) this.publish(record.metadata, record.readyAt); },
    publish(metadata: AttachmentMetadata, readyAt: string) {
      if (state.files.has(metadata.id)) throw Error("Attachment ID already exists");
      if (state.base === undefined) { const base = format(); if (base !== 6 && base !== 7 && base !== 8) throw Error("Unsupported base format"); setBase(base); }
      put(state.files, metadata.id, { metadata, readyAt });
    },
    get: (id: string) => copy(state.files.get(id)),
    associate(id: string, itemId: string) {
      if (!state.files.has(id) || !item(itemId)) throw Error("Unknown attachment or item");
      const next = new Set(state.links.get(id)); next.add(itemId); put(state.links, id, next);
    },
    saveParts(itemId: string, parts: readonly InputPart[]) {
      if (state.parts.has(itemId)) throw Error("Attachment parts already exist");
      put(state.parts, itemId, [...parts]);
      for (const part of parts) if (part.type === "attachment") this.associate(part.id, itemId);
    },
    parts: (itemId: string) => copy(state.parts.get(itemId)),
    isRetained: (id: string) => (state.links.get(id)?.size ?? 0) > 0,
    isTimelineVisible: (id: string) => [...state.links.get(id) ?? []].some(itemId => item(itemId)?.entrySeq !== undefined),
    unreferencedBefore: (readyAt: string) => [...state.files.values()].filter(row => row.readyAt <= readyAt && !(state.links.get(row.metadata.id)?.size)).sort((a, b) => a.metadata.id.localeCompare(b.metadata.id)).map(copy),
    reclaim(id: string, readyAt: string) {
      const row = state.files.get(id);
      if (!row || row.readyAt > readyAt || (state.links.get(id)?.size ?? 0) > 0) return false;
      log(() => state.files.set(id, row)); state.files.delete(id); return true;
    },
  };
}
