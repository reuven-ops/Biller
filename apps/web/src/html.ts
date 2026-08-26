// Server-rendered HTML with escaping by default. Plain pages, no design system
// (brief section 13). The `html` tag escapes every interpolated value unless it
// was already marked safe with `raw` (used only for nested html`` output).

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ESCAPES[ch] ?? ch);
}

export class Safe {
  constructor(readonly value: string) {}
}

export function raw(value: string): Safe {
  return new Safe(value);
}

type Piece = string | number | boolean | null | undefined | Safe | Piece[];

function render(piece: Piece): string {
  if (piece === null || piece === undefined || piece === false) return '';
  if (piece instanceof Safe) return piece.value;
  if (Array.isArray(piece)) return piece.map(render).join('');
  return escapeHtml(String(piece));
}

export function html(strings: TemplateStringsArray, ...values: Piece[]): Safe {
  let out = '';
  for (let i = 0; i < strings.length; i += 1) {
    out += strings[i];
    if (i < values.length) out += render(values[i]);
  }
  return new Safe(out);
}

const STYLE = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0; color: #1a1a1a; background: #fafafa; }
  header { background: #123c63; color: #fff; padding: 0.6rem 1rem; display: flex; gap: 1rem; align-items: baseline; flex-wrap: wrap; }
  header .brand { font-weight: 700; }
  header nav { display: flex; gap: 0.9rem; flex-wrap: wrap; }
  header a { color: #cfe1f5; text-decoration: none; }
  header a:hover, header a.active { color: #fff; text-decoration: underline; }
  header .who { margin-left: auto; color: #cfe1f5; font-size: 0.85rem; }
  main { max-width: 62rem; margin: 1rem auto 3rem; padding: 0 1rem; }
  h1 { font-size: 1.3rem; } h2 { font-size: 1.05rem; margin-top: 1.6rem; }
  .card { background: #fff; border: 1px solid #ddd; border-radius: 6px; padding: 1rem; margin: 0.8rem 0; }
  label { display: block; font-weight: 600; margin: 0.6rem 0 0.15rem; }
  input[type=text], input[type=email], input[type=password], input[type=date], select, textarea {
    width: 100%; padding: 0.45rem; border: 1px solid #bbb; border-radius: 4px; font: inherit; background: #fff; }
  textarea { min-height: 5.5rem; }
  .row { display: flex; gap: 0.8rem; flex-wrap: wrap; } .row > div { flex: 1 1 10rem; }
  button { font: inherit; padding: 0.45rem 0.9rem; border-radius: 4px; border: 1px solid #123c63; background: #123c63; color: #fff; cursor: pointer; }
  button.quiet { background: #fff; color: #123c63; }
  .error { background: #fbe9e7; border: 1px solid #d9534f; color: #8b1a12; padding: 0.6rem 0.8rem; border-radius: 4px; margin: 0.8rem 0; }
  .notice { background: #e8f1fb; border: 1px solid #7ba7d0; padding: 0.6rem 0.8rem; border-radius: 4px; margin: 0.8rem 0; }
  .muted { color: #666; font-size: 0.85rem; }
  .tier { display: inline-block; font-size: 0.72rem; font-weight: 700; padding: 0 0.35rem; border-radius: 3px; background: #eef; border: 1px solid #99b; color: #334; margin-right: 0.3rem; }
  details.cite { margin: 0.25rem 0 0.25rem 1rem; }
  details.cite summary { cursor: pointer; color: #123c63; font-size: 0.85rem; }
  details.cite blockquote { margin: 0.4rem 0 0.4rem 0.8rem; padding-left: 0.7rem; border-left: 3px solid #ccd; color: #333; white-space: pre-wrap; }
  table { border-collapse: collapse; width: 100%; } th, td { text-align: left; padding: 0.35rem 0.5rem; border-bottom: 1px solid #e2e2e2; vertical-align: top; }
  .bottom-line { font-size: 1.05rem; font-weight: 600; }
  .pill { display: inline-block; background: #eee; border-radius: 999px; padding: 0.05rem 0.6rem; margin: 0.1rem 0.2rem 0.1rem 0; font-size: 0.82rem; }
  .abstain { border-left: 4px solid #d9534f; }
  form.inline { display: inline; }
`;

export interface PageUser {
  name: string;
  email: string;
  role: 'biller' | 'lead' | 'admin';
}

const NAV: { href: string; label: string; roles?: string[] }[] = [
  { href: '/', label: 'Ask' },
  { href: '/history', label: 'History' },
  { href: '/notes', label: 'Call notes' },
  { href: '/sources', label: 'Sources' },
  { href: '/admin', label: 'Admin', roles: ['admin'] },
  { href: '/help', label: 'Help' },
];

export function layout(opts: {
  title: string;
  user?: PageUser | undefined;
  active?: string | undefined;
  refreshSeconds?: number | undefined;
  csrf?: string | undefined;
  body: Safe;
}): string {
  const nav = opts.user
    ? NAV.filter((n) => !n.roles || n.roles.includes(opts.user?.role ?? ''))
    : [];
  const page = html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        ${
          opts.refreshSeconds
            ? raw(`<meta http-equiv="refresh" content="${Math.floor(opts.refreshSeconds)}" />`)
            : null
        }
        <title>${opts.title} - CM Coding Advisor</title>
        <style>
          ${raw(STYLE)}
        </style>
      </head>
      <body>
        <header>
          <span class="brand">CM Coding Advisor</span>
          <nav>
            ${nav.map(
              (n) =>
                html`<a href="${n.href}" class="${n.href === opts.active ? 'active' : ''}"
                  >${n.label}</a
                >`,
            )}
          </nav>
          ${
            opts.user
              ? html`<span class="who"
                  >${opts.user.email} (${opts.user.role})
                  <form class="inline" method="post" action="/logout">
                    <input type="hidden" name="csrf" value="${opts.csrf ?? ''}" />
                    <button class="quiet" type="submit">Sign out</button>
                  </form></span
                >`
              : null
          }
        </header>
        <main>${opts.body}</main>
      </body>
    </html>`;
  return page.value;
}
