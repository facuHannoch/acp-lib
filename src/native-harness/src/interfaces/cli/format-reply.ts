/** Small terminal renderer for common Markdown, preserving fenced code verbatim. */
export function formatReply(markdown: string, color = process.stdout.isTTY && !process.env.NO_COLOR): string {
  const style = (text: string, code: string) => color ? `\x1b[${code}m${text}\x1b[0m` : text;
  const inline = (text: string) => text.replace(
    /`([^`]+)`|\*\*(.+?)\*\*|__(.+?)__|\*([^*\n]+)\*|~~(.+?)~~|\[([^\]]+)\]\(([^)]+)\)/g,
    (_match, code, bold, underscoreBold, italic, strike, label, url) => {
      if (code !== undefined) return style(code, "36");
      if (bold !== undefined || underscoreBold !== undefined) return style(bold ?? underscoreBold, "1");
      if (italic !== undefined) return style(italic, "3");
      if (strike !== undefined) return style(strike, "9");
      return label === url ? style(url, "4") : `${label} (${url})`;
    },
  );
  let fence: string | undefined;
  return markdown.split("\n").map(line => {
    const marker = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (marker && (!fence || (marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && !marker[2]!.trim()))) {
      if (fence) { fence = undefined; return ""; }
      fence = marker[1];
      return marker[2]!.trim() ? style(marker[2]!.trim(), "2") : "";
    }
    if (fence) return `  ${line}`;
    const heading = line.match(/^#{1,6}\s+(.+?)\s*#*$/);
    if (heading) return style(inline(heading[1]!), "1");
    return inline(line.replace(/^(\s*)[-*+]\s+/, "$1• ").replace(/^>\s?/, "│ "));
  }).join("\n");
}
