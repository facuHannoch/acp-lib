import { Database } from "bun:sqlite";
import { lstatSync, unlinkSync } from "node:fs";
import { createConnection } from "node:net";

function code(error: unknown) {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function atPath(path: string) {
  try { return lstatSync(path, { bigint: true }); }
  catch (error) { if (code(error) !== "ENOENT") throw error; }
}

/** A live listener can use any protocol. Only a Unix connect refusal is
 * evidence of a stale socket. Timeouts and permission errors stay ambiguous. */
function isRefused(path: string) {
  return new Promise<boolean>((resolve, reject) => {
    const socket = createConnection({ path });
    socket.setTimeout(500);
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
    socket.once("connect", () => { socket.destroy(); resolve(false); });
    socket.once("error", error => {
      if (code(error) === "ECONNREFUSED" || code(error) === "ENOENT") resolve(true);
      else reject(error);
    });
  });
}

export async function bindLocalSocket<T>(path: string, bind: () => T): Promise<T> {
  try { return bind(); }
  catch (error) { if (code(error) !== "EADDRINUSE") throw error; }

  const old = atPath(path);
  if (!old) return bind();
  if (!old.isSocket() || (process.getuid && BigInt(process.getuid()) !== old.uid))
    throw new Error(`Cannot listen at ${path}: the path is occupied by another file or owner`);

  if (!await isRefused(path)) {
    throw new Error(`A server already listens at ${path}. Connect with bun run chat, or choose a different HARNESS_SOCKET.`);
  }

  // Serialize recovering starters with an OS-released SQLite lock. A normal
  // bind stays atomic and needs no lock. The empty lock file is kept so every
  // recovering process opens the same inode, even after a crash.
  const lockPath = `${path}.recovery.sqlite`;
  const existingLock = atPath(lockPath);
  if (existingLock && (!existingLock.isFile() || existingLock.uid !== old.uid))
    throw new Error(`Cannot recover ${path}: the socket recovery lock has a different owner or file type`);
  const lock = new Database(lockPath);
  try {
    lock.exec("BEGIN IMMEDIATE");
    const current = atPath(path);
    if (current?.isSocket() && current.ino === old.ino && current.dev === old.dev && current.ctimeNs === old.ctimeNs)
      unlinkSync(path);
    return bind();
  } catch (error) {
    if (code(error) === "EADDRINUSE" || code(error) === "SQLITE_BUSY")
      throw new Error(`Another server is starting or already listening at ${path}. Connect with bun run chat, or choose a different HARNESS_SOCKET.`);
    throw error;
  } finally {
    lock.close();
  }
}

/** Keep the usual browser ports when available. A port chosen explicitly by
 * the caller should either bind exactly or report which setting conflicted. */
export function bindWebPort<T>(port: number, variable: string, bind: (port: number) => T): T {
  try { return bind(port); }
  catch (error) {
    if (code(error) !== "EADDRINUSE") throw error;
    if (process.env[variable] === undefined && port !== 0) return bind(0);
    throw new Error(`Port ${port} is already in use. Set ${variable}=0 to choose an available port.`);
  }
}
