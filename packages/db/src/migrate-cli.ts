import { migrate } from './migrate.js';
import { requireEnv } from './env.js';

const url = requireEnv('MIGRATOR_DATABASE_URL');
const result = await migrate(url);
for (const name of result.applied) {
  console.log(`applied  ${name}`);
}
console.log(`${result.applied.length} applied, ${result.skipped.length} already applied.`);
