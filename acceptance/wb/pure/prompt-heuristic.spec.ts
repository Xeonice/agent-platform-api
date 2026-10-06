import { describe, expect, it } from 'vitest';
import { PromptHeuristic } from '../../../packages/modules/terminal/src/domain/services/prompt-heuristic';

describe('display-only terminal prompt heuristic', () => {
  it.each([
    ['shell', 'build complete\r\nuser@host:/workspace $ ', true],
    ['REPL', '❯ ', true],
    ['question', 'Do you want to continue?', true],
    ['confirmation', 'Proceed [y/N] ', true],
    ['choice', 'Enter your choice:', true],
    ['CSI and trailing empty lines', '\u001b[32m❯\u001b[0m \r\n\r\n', true],
    ['OSC hyperlink', '\u001b]8;;https://example.test\u0007host\u001b]8;;\u0007 $ ', true],
    ['C1 CSI', '\u009b32m❯\u009b0m', true],
    ['string command', '\u001bPignored $ text\u001b\\Thinking…', false],
    ['work after a prompt', '$ run build\nCompiling sources', false],
    ['spinner', '⠋ Working (12s)', false],
    ['no output', '', false],
    ['control codes only', '\u001b[2J\u001b[H', false],
    // A thinking CLI can print a question-shaped line: this is intentionally just a visual hint.
    ['acknowledged false positive', 'Why did that test fail?', true],
  ])('%s', (_name, tail, expected) => {
    expect(new PromptHeuristic().looksLikePrompt(tail)).toBe(expected);
  });

  it('supports a configured narrow prompt and resets stateful regexes', () => {
    const heuristic = new PromptHeuristic([/^CUSTOM READY$/g]);
    expect(heuristic.looksLikePrompt('$ ')).toBe(false);
    expect(heuristic.looksLikePrompt('CUSTOM READY')).toBe(true);
    expect(heuristic.looksLikePrompt('CUSTOM READY')).toBe(true);
  });
});
