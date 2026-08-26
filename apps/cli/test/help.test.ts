import { describe, expect, it } from 'vitest';
import { COMMANDS, helpText } from '../src/help.js';

describe('cli help', () => {
  it('covers every command from CLAUDE.md', () => {
    const names = COMMANDS.map((c) => c.name);
    for (const expected of [
      'ask',
      'ingest',
      'eval',
      'report',
      'freshness',
      'users',
      'backup',
      'restore',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('prints usage for every command', () => {
    const text = helpText();
    for (const c of COMMANDS) {
      expect(text).toContain(c.usage);
    }
  });
});
