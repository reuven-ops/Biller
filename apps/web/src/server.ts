// Phase 0 web entry: a health endpoint and a placeholder page so docker compose up
// brings up db and app locally (brief Phase 0 acceptance). The full application
// (auth, Ask, History, Sources, Admin, Help) lands in Phase 3 (PLAN.md M3.x).
import { createServer } from 'node:http';
import { getPool, intEnv, loadEnv } from '@advisor/db';

loadEnv();
const port = intEnv('APP_PORT', 3000);

async function dbStatus(): Promise<{ ok: boolean; migrations: number; error?: string }> {
  try {
    const pool = getPool();
    const res = await pool.query<{ n: string }>('SELECT count(*) AS n FROM schema_migrations');
    return { ok: true, migrations: Number(res.rows[0]?.n ?? 0) };
  } catch (err) {
    return { ok: false, migrations: 0, error: (err as Error).message };
  }
}

const server = createServer((req, res) => {
  void (async () => {
    if (req.url === '/healthz') {
      const db = await dbStatus();
      const body = JSON.stringify({ ok: db.ok, db });
      res.writeHead(db.ok ? 200 : 503, { 'content-type': 'application/json' });
      res.end(body);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      '<!doctype html><title>CM Coding Advisor</title>' +
        '<h1>CM Coding Advisor</h1>' +
        '<p>Phase 0 scaffold. The biller application arrives in Phase 3. ' +
        'Health: <a href="/healthz">/healthz</a></p>',
    );
  })().catch((err: unknown) => {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end(`internal error: ${(err as Error).message}`);
  });
});

server.listen(port, () => {
  console.log(`app: listening on :${port}`);
});
