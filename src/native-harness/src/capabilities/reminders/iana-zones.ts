import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import type { ProofZoneRange } from "./cron-proof.ts";

type Zone = [initialSeconds: number, changes: [utcSeconds: number, offsetSeconds: number][]];
type Catalog = [version: string, tailStart: number, tailPeriod: number, zones: Record<string, Zone>, aliases: Record<string, string>];

let catalog: Catalog | undefined;
const start = Date.parse("0000-01-01T00:00:00.000Z");
const end = Date.parse("9999-12-31T23:59:59.999Z");
const milliseconds = 1000;

export function resolveRoutineZone(name: string): (ProofZoneRange & { timezone: string; timezoneVersion: string }) | undefined {
  catalog ??= JSON.parse(gunzipSync(readFileSync(new URL("./iana-zones.json.gz", import.meta.url))).toString()) as Catalog;
  const [timezoneVersion, tailStart, period, zones, aliases] = catalog;
  let timezone = name;
  const visited = new Set<string>();
  while (Object.hasOwn(aliases, timezone)) {
    if (visited.has(timezone)) return;
    visited.add(timezone);
    timezone = aliases[timezone]!;
  }
  if (!Object.hasOwn(zones, timezone)) return;
  const [initialOffset, changes] = zones[timezone]!;
  const transitions = changes.map(([at, offset]) => ({ at: at * milliseconds, offset: offset * milliseconds }));
  const tail = changes.filter(([at]) => at >= tailStart);
  for (let shift = period; tail.length && (tailStart + shift) * milliseconds <= end; shift += period) {
    for (const [at, offset] of tail) {
      if ((at + shift) * milliseconds <= end)
        transitions.push({ at: (at + shift) * milliseconds, offset: offset * milliseconds });
    }
  }
  return { timezone, timezoneVersion, start, end, initialOffset: initialOffset * milliseconds, transitions };
}
