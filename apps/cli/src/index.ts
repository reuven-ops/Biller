import { COMMANDS, helpText } from './help.js';

const [command, ...rest] = process.argv.slice(2);

if (command === undefined || command === 'help' || command === '--help') {
  console.log(helpText());
  process.exit(0);
}

const known = COMMANDS.find((c) => c.name === command);
if (!known) {
  console.error(`Unknown command: ${command}\n`);
  console.log(helpText());
  process.exit(1);
}

switch (command) {
  case 'ask': {
    const { runAskCommand } = await import('./commands/ask.js');
    await runAskCommand(rest);
    break;
  }
  case 'ingest': {
    const { runIngestCommand } = await import('./commands/ingest.js');
    await runIngestCommand(rest);
    break;
  }
  case 'report': {
    const { runReportCommand } = await import('./commands/report.js');
    await runReportCommand();
    break;
  }
  case 'freshness': {
    const { runFreshnessCommand } = await import('./commands/freshness.js');
    await runFreshnessCommand();
    break;
  }
  default: {
    console.error(
      `${command}: not implemented yet. It arrives in Phase ${known.phase} (docs/PLAN.md).`,
    );
    process.exit(2);
  }
}
