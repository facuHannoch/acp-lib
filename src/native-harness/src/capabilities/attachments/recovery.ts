import { constants, fsyncSync, openSync, closeSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const publishedName = new RegExp(`^${UUID}$`);
const stagedName = new RegExp(`^\\.stage-${UUID}$`);

/** Invoke only under exclusive session ownership after reading committed ready
 * IDs. An orphan is a stage from a dead owner or published bytes without ready
 * metadata. A committed file is never removed here, whether referenced or not.
 * Unknown names are left untouched; no directory entries are followed. */
export function recoverAttachmentOrphans(root: string, readyIds: ReadonlySet<string>): { removed: string[] } {
  const removed: string[] = [];
  const fd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const name = entry.name;
      if (!stagedName.test(name) && !(publishedName.test(name) && !readyIds.has(name))) continue;
      if (entry.isDirectory()) continue;
      rmSync(join(root, name), { force: true });
      removed.push(name);
    }
    if (removed.length) fsyncSync(fd);
  } finally { closeSync(fd); }
  return { removed: removed.sort() };
}
