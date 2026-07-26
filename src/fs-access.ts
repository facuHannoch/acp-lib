// Client-side filesystem access (ACP `fs/read_text_file`, `fs/write_text_file`).
//
// We advertise the fs capabilities, so these must actually work — previously the
// transport answered every read with `{content: ""}` and silently discarded writes,
// which reads to an agent as "the file is empty" / "the write succeeded".

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface ReadTextFileParams {
  path: string;
  /** 1-based line to start from. */
  line?: number | null;
  /** Maximum number of lines to return. */
  limit?: number | null;
}

export interface WriteTextFileParams {
  path: string;
  content: string;
}

/** Read a file, honouring the protocol's optional line window. */
export async function readTextFile(params: ReadTextFileParams): Promise<string> {
  const content = await readFile(params.path, "utf8");
  if (params.line == null && params.limit == null) return content;

  const lines = content.split("\n");
  const start = Math.max((params.line ?? 1) - 1, 0);
  const end = params.limit != null ? start + Math.max(params.limit, 0) : lines.length;
  return lines.slice(start, end).join("\n");
}

/** Write a file, creating parent directories as needed. */
export async function writeTextFile(params: WriteTextFileParams): Promise<void> {
  await mkdir(dirname(params.path), { recursive: true });
  await writeFile(params.path, params.content, "utf8");
}
