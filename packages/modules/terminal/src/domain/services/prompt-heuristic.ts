/** Pure hint for display. CLI output can resemble prompts; never drive decisions from it. */
export class PromptHeuristic {
  static readonly DEFAULT_PATTERNS = [/[>$#❯➜»]\s*$/, /\?\s*$/, /\[[yYnN]\/[yYnN]\]\s*$/, /:\s*$/];

  constructor(private readonly patterns: readonly RegExp[] = PromptHeuristic.DEFAULT_PATTERNS) {}

  looksLikePrompt(rawTail: string): boolean {
    const lastLine = stripControls(rawTail)
      .split(/[\r\n]/)
      .filter((line) => line.trim() !== '')
      .at(-1);
    if (lastLine === undefined) return false;
    return this.patterns.some((pattern) => {
      pattern.lastIndex = 0;
      return pattern.test(lastLine);
    });
  }
}

/** Strip CSI, OSC (including hyperlinks), string commands and C0 cursor controls. */
function stripControls(raw: string): string {
  let result = '';
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    if (code === 27 || code === 155) {
      const kind = code === 155 ? '[' : raw[++i];
      if (kind === '[') {
        while (++i < raw.length) {
          const end = raw.charCodeAt(i);
          if (end >= 64 && end <= 126) break;
        }
      } else if (kind === ']' || kind === 'P' || kind === '^' || kind === '_') {
        while (++i < raw.length) {
          if (kind === ']' && raw.charCodeAt(i) === 7) break;
          if (raw.charCodeAt(i) === 27 && raw[i + 1] === '\\') {
            i += 1;
            break;
          }
        }
      } else {
        while (i < raw.length && raw.charCodeAt(i) >= 32 && raw.charCodeAt(i) <= 47) i += 1;
      }
    } else if (code >= 32 && code !== 127 && !(code >= 128 && code <= 159)) {
      result += raw[i];
    } else if (code === 9 || code === 10 || code === 13) {
      result += raw[i];
    }
  }
  return result;
}
