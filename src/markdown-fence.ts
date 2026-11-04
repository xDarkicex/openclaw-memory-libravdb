/** Tracks Markdown fenced blocks, including their opening and closing lines. */
export function createMarkdownFenceTracker(): (line: string) => boolean {
  let marker: string | null = null;
  let length = 0;

  return (line) => {
    const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(normalized);
    if (marker) {
      if (match && match[1][0] === marker && match[1].length >= length && /^[ \t]*$/.test(match[2])) {
        marker = null;
      }
      return true;
    }

    // A backtick fence's info string cannot itself contain a backtick.
    if (!match || (match[1][0] === "`" && match[2].includes("`"))) {
      return false;
    }
    marker = match[1][0];
    length = match[1].length;
    return true;
  };
}
