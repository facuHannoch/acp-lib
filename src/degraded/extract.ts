// extractReply — stage 3 of the degraded pipeline: a clean screen grid → just the
// agent's latest reply. This is the deterministic DEFAULT; an injected ScreenParser
// (SML) can replace it for messier TUIs. See SPEC.md "The parsing pipeline".
//
// Strategy (marker/anchor based, works for "bullet reply" TUIs like codex):
//   1. Anchor on the echoed user prompt (the line containing the text we sent).
//   2. The reply is the lines AFTER it, up to the next input-prompt / status chrome.
//   3. Strip bullet markers and known chrome.
// If the anchor isn't found (long/wrapped prompts), fall back to the pre/post diff:
// the lines that appeared since before we submitted, minus chrome.

const INPUT_PROMPT = /^\s*[›❯»]\s/; // a redrawn input box / next prompt line
const SHELL_PROMPT = /[$#%❯➜]\s*$/; // trailing shell prompt (bash "...# ", zsh "% ")
const BULLET = /^\s*[•▌▍●∙]\s+/; // reply bullet markers
const STATUS_BAR = /·/; // codex status line: "gpt-5.5 medium · ~/path"
const BOX = /^[╭╰│╮╯─┌┐└┘]/;

/** A line that marks the END of the reply region (start of post-reply chrome). */
function isStopLine(line: string): boolean {
  const t = line.trim();
  if (INPUT_PROMPT.test(line)) return true;
  if (t.length < 120 && SHELL_PROMPT.test(t)) return true;
  if (t.length < 120 && STATUS_BAR.test(t)) return true;
  return false;
}

function isChrome(line: string): boolean {
  const t = line.trim();
  if (t === "") return true;
  if (isStopLine(line)) return true;
  if (BOX.test(t)) return true; // box drawing (banner)
  if (/^Tip:/.test(t)) return true;
  return false;
}

function cleanReplyLines(lines: string[]): string[] {
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(BULLET, "").replace(/\s+$/, "");
    if (line === "" && (out[out.length - 1] ?? "x") === "") continue;
    out.push(line);
  }
  return out;
}

function trimBlank(lines: string[]): string[] {
  const out = [...lines];
  while (out.length && (out[0] ?? "").trim() === "") out.shift();
  while (out.length && (out[out.length - 1] ?? "").trim() === "") out.pop();
  return out;
}

/**
 * @param lines     compacted post-settle grid (one entry per row).
 * @param sentText  the prompt we submitted (used to locate its echo).
 * @param preLines  optional pre-submit grid, to subtract static chrome on fallback.
 */
export function extractReply(lines: string[], sentText: string, preLines?: string[]): string {
  const needle = sentText.trim();

  // 1. Anchor on the echoed prompt (search from the bottom — the latest echo).
  let anchor = -1;
  if (needle) {
    for (let i = lines.length - 1; i >= 0; i--) {
      if ((lines[i] ?? "").includes(needle)) {
        anchor = i;
        break;
      }
    }
  }

  if (anchor >= 0) {
    const after: string[] = [];
    for (let i = anchor + 1; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (isStopLine(line)) break; // next input prompt / status / shell prompt
      after.push(line);
    }
    const reply = trimBlank(cleanReplyLines(after)).join("\n").trim();
    if (reply) return reply;
  }

  // 2. Fallback: lines that appeared since the pre-submit snapshot, minus chrome.
  const before = new Set((preLines ?? []).map((l) => l.trim()));
  const fresh = lines.filter((l) => !before.has(l.trim()) && !isChrome(l));
  return trimBlank(cleanReplyLines(fresh)).join("\n").trim();
}
