// Help (brief section 13.6), rendered from docs/HELP.md.
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { html, layout } from '../html.js';
import { sendHtml, type Handler, type Router } from '../http.js';
import { renderMarkdown } from '../markdown.js';

const HELP_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'docs',
  'HELP.md',
);

interface AuthedLike {
  user: { name: string; email: string; role: 'biller' | 'lead' | 'admin' };
  csrf: string;
}
type Authed = (
  minRole: 'biller' | 'lead' | 'admin',
  handler: (ctx: AuthedLike & Parameters<Handler>[0]) => Promise<void> | void,
) => Handler;

export function registerHelpRoutes(router: Router, authed: Authed): void {
  router.get(
    '/help',
    authed('biller', async (ctx) => {
      const markdown = await readFile(HELP_PATH, 'utf8').catch(() => '# Help\n\nHELP.md missing.');
      sendHtml(
        ctx,
        200,
        layout({
          title: 'Help',
          user: ctx.user,
          active: '/help',
          csrf: ctx.csrf,
          body: html`<div class="card">${renderMarkdown(markdown)}</div>`,
        }),
      );
    }),
  );
}
