export interface CommandHelp {
  name: string;
  usage: string;
  summary: string;
  phase: number;
}

export const COMMANDS: CommandHelp[] = [
  {
    name: 'ask',
    usage:
      'pnpm ask "question" [--dos YYYY-MM-DD] [--payer P] [--jurisdiction J] [--provider T] [--client C]',
    summary: 'Ask a coding or billing question and print the cited answer.',
    phase: 2,
  },
  {
    name: 'ingest',
    usage: 'pnpm ingest <source_id> [--limit N]',
    summary: 'Run one courier now. --limit fetches a sample for parser validation.',
    phase: 1,
  },
  {
    name: 'eval',
    usage: 'pnpm eval',
    summary: 'Run the golden set and print results by gate (brief section 16).',
    phase: 2,
  },
  {
    name: 'report',
    usage: 'pnpm report',
    summary: 'Print usage, cost, latency, and feedback metrics by day.',
    phase: 2,
  },
  {
    name: 'freshness',
    usage: 'pnpm freshness',
    summary: 'Print last success, cadence, and stale flag for every enabled source.',
    phase: 1,
  },
  {
    name: 'users',
    usage: 'pnpm users add <email> <role>',
    summary: 'Manage users. Roles: biller, lead, admin.',
    phase: 3,
  },
  {
    name: 'backup',
    usage: 'pnpm backup',
    summary: 'Write an encrypted database backup to BACKUP_TARGET.',
    phase: 5,
  },
  {
    name: 'restore',
    usage: 'pnpm restore <file>',
    summary: 'Restore the database from a backup file.',
    phase: 5,
  },
];

export function helpText(): string {
  const lines = ['CM Coding Advisor CLI', ''];
  for (const c of COMMANDS) {
    lines.push(`  ${c.usage}`);
    lines.push(`      ${c.summary}`);
  }
  lines.push('');
  lines.push('Also: pnpm db:migrate, pnpm test, pnpm lint. See CLAUDE.md.');
  return lines.join('\n');
}
