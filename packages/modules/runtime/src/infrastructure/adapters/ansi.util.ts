/**
 * Minimal ANSI / control-sequence stripping for CLI stdout parsing. Removes CSI
 * (`ESC [ … letter`) and OSC (`ESC ] … ST`) sequences and stray control bytes, but
 * PRESERVES newlines (the token-fold reconstruction depends on line structure).
 * OSC-8 hyperlink URLs must be parsed with `extractOsc8Urls` BEFORE stripping.
 */
const CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const OTHER_ESC = /\x1b[@-Z\\-_]/g;
// control bytes except \n (0x0a) and \r (0x0d)
const CTRL = /[\x00-\x09\x0b\x0c\x0e-\x1f]/g;

export function stripAnsi(text: string): string {
  return text.replace(OSC, '').replace(CSI, '').replace(OTHER_ESC, '').replace(CTRL, '');
}

/**
 * Extract every OSC-8 hyperlink URL from raw output. OSC-8 form:
 *   ESC ] 8 ; [params] ; URI  ST      (ST = BEL 0x07 or ESC \).
 * The visible link text is truncated by the pty, so the URI must come from HERE —
 * a plain `grep https://` gets the truncated visible text (05 §1 ★1).
 */
export function extractOsc8Urls(text: string): string[] {
  const re = /\x1b\]8;[^;]*;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const uri = m[1];
    if (uri && uri.length > 0) out.push(uri);
  }
  return out;
}
