/** Closing offset, -1 for invalid syntax, or undefined while it can still complete. */
function linkEnd(text: string, start: number): number | undefined {
  let depth = 0;
  let angle = false;
  let title: string | undefined;
  let afterDestination = false;
  let afterTitle = false;
  let destinationStarted = false;
  for (let index = start; index < text.length; index++) {
    const character = text[index];
    if (character === "\\") {
      index++;
      continue;
    }
    if (character === "\n" && /^\s*\n/.test(text.slice(index + 1))) return -1;
    if (angle) {
      if (character === ">") {
        angle = false;
        afterDestination = true;
      } else if (character === "\n") return -1;
      continue;
    }
    if (title) {
      if (character === title) {
        title = undefined;
        afterTitle = true;
      }
      continue;
    }
    if (/\s/.test(character)) {
      if (depth) return -1;
      if (destinationStarted) afterDestination = true;
      continue;
    }
    if (character === ")" && depth === 0) return index;
    if (afterTitle) return -1;
    if (afterDestination) {
      if (character === '"' || character === "'" || character === "(") {
        title = character === "(" ? ")" : character;
        continue;
      }
      return -1;
    }
    if (!destinationStarted && character === "<") angle = true;
    else if (character === "<" || character === ">") return -1;
    else if (character === "(") depth++;
    else if (character === ")") depth--;
    destinationStarted = true;
  }
  return undefined;
}

/** Display-only: hold the unfinished link suffix while the current reply streams. */
export function bufferIncompleteMarkdownLinks(text: string): string {
  const brackets: number[] = [];
  let fence: { marker: string; length: number } | undefined;
  for (let index = 0; index < text.length; index++) {
    if (index === 0 || text[index - 1] === "\n") {
      const lineEnd = text.indexOf("\n", index);
      const end = lineEnd < 0 ? text.length : lineEnd;
      const line = text.slice(index, end);
      const marker = /^(?: {0,3}> ?)* {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (fence || marker || /^(?: {4}|\t)/.test(line)) {
        if (fence) {
          if (
            marker &&
            marker[1][0] === fence.marker &&
            marker[1].length >= fence.length &&
            !marker[2].trim()
          )
            fence = undefined;
        } else if (marker)
          fence = { marker: marker[1][0], length: marker[1].length };
        brackets.length = 0;
        index = end;
        continue;
      }
      // A link cannot consume another paragraph of otherwise complete prose.
      if (!line.trim()) brackets.length = 0;
    }
    const character = text[index];
    if (character === "\\") {
      index++;
      continue;
    }
    if (character === "`") {
      let length = 1;
      while (text[index + length] === "`") length++;
      const delimiter = "`".repeat(length);
      let end = text.indexOf(delimiter, index + length);
      while (end >= 0 && (text[end - 1] === "`" || text[end + length] === "`"))
        end = text.indexOf(delimiter, end + length);
      // Preserve an unfinished code span verbatim, including bracket examples.
      if (end < 0) return text;
      index = end + length - 1;
      continue;
    }
    if (character === "[") {
      // A bare URL can contain bracketed query keys; it is not a Markdown label.
      if (brackets.length || !/https?:\/\/\S*$/.test(text.slice(0, index)))
        brackets.push(index);
    } else if (character === "]" && brackets.length) {
      const start = brackets.pop()!;
      if (text[index + 1] !== "(") continue;
      const end = linkEnd(text, index + 2);
      if (end === undefined)
        return text.slice(0, text[start - 1] === "!" ? start - 1 : start);
      if (end >= 0) {
        index = end;
        brackets.length = 0;
      }
    }
  }
  const start = brackets[0];
  return start === undefined
    ? text
    : text.slice(0, text[start - 1] === "!" ? start - 1 : start);
}
