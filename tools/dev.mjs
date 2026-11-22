// Local stand-in for Cloudflare: runs dist/worker.js under Node with a D1 shim over node:sqlite.
// For development only.  Run:  node build.mjs && node tools/dev.mjs  →  http://localhost:8787
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const root = new URL('../', import.meta.url);
const sqlite = new DatabaseSync(process.env.ML_DB || ':memory:');
sqlite.exec(readFileSync(new URL('worker/schema.sql', root), 'utf8'));

class Statement {
  constructor(sql, args = []) { this.sql = sql; this.args = args; }
  bind(...args) { return new Statement(this.sql, args); }
  async first(column) {
    const row = sqlite.prepare(this.sql).get(...this.args);
    if (!row) return null;
    return column ? row[column] : { ...row };
  }
  async all() { return { results: sqlite.prepare(this.sql).all(...this.args).map((r) => ({ ...r })) }; }
  async run() { const r = sqlite.prepare(this.sql).run(...this.args); return { meta: { changes: r.changes } }; }
}
const DB = {
  prepare: (sql) => new Statement(sql),
  batch: async (statements) => {
    const out = [];
    for (const s of statements) out.push(/^\s*select/i.test(s.sql) ? await s.all() : (await s.run(), { results: [] }));
    return out;
  },
};

const worker = (await import(new URL('dist/worker.js', root))).default;
const port = Number(process.env.PORT || 8787);

http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  if (!headers.has('cf-connecting-ip')) headers.set('cf-connecting-ip', req.socket.remoteAddress || 'local');
  const request = new Request('http://' + req.headers.host + req.url, {
    method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined,
  });
  const env = { DB, ADMIN_KEY: process.env.ADMIN_KEY, MAX_HUMANS_PER_HOUR: process.env.MAX_HUMANS_PER_HOUR, BLOCKED_TERMS: process.env.BLOCKED_TERMS, LINEUP: process.env.LINEUP, NETWORK: process.env.NETWORK };
  // FAKE_SITES=<file.json> stands in for the open web when a node is checked: { "example.org": "<html>...</html>" }.
  // The file is read on every check, so a test can put a node's line into it after opening the node.
  if (process.env.FAKE_SITES) {
    env.NODE_FETCH = async (target) => {
      const sites = JSON.parse(readFileSync(process.env.FAKE_SITES, 'utf8'));
      const at = new URL(target);
      const page = sites[at.hostname + (at.pathname === '/' ? '' : at.pathname)];
      if (typeof page !== 'string') throw new Error('ENOTFOUND ' + at.hostname);
      const response = new Response(page, { status: 200, headers: { 'content-type': 'text/html', ...(sites['#' + at.hostname] ? { 'content-security-policy': sites['#' + at.hostname] } : {}) } });
      Object.defineProperty(response, 'url', { value: sites['>' + at.hostname] || target });
      return response;
    };
  }
  // FAKE_AI=1 stands in for Workers AI with canned lines, so the lineup can be exercised offline.
  if (process.env.FAKE_AI) {
    const lines = ['leftover soup my neighbour made', 'A toast sandwich. I am not proud of it.', 'ramen lol', 'my mum made dolma on sunday', 'Canteen rice. It was rice.', 'pasta, no wait, it was the lentil thing'];
    let i = 0;
    // FAKE_AI=broken: the first model is gone (as a retired model would be) and the second answers in the chat-completions shape.
    env.AI = { run: async (model) => {
      if (process.env.FAKE_AI === 'broken' && /gemma/.test(model)) throw new Error('410 Gone: model retired');
      const line = lines[i++ % lines.length];
      return process.env.FAKE_AI === 'broken' ? { choices: [{ message: { content: '"' + line + '"\n' } }] } : { response: line };
    } };
  }
  const response = await worker.fetch(request, env, { waitUntil: (work) => work.catch(() => {}) });
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(port, () => console.log('node 00 listening on http://localhost:' + port));
