// Media Lockout · node 00
// One Worker: serves the page and its two assets, and runs the human registry.
// ASSETS ({ html, css, js }) is prepended by build.mjs.

const DAY = 86400000;
const SILENCE_MS = 7000;          // the silence check
const MIN_RITUAL_MS = 9000;       // nothing human finishes all three checks faster
const CHALLENGE_TTL = 30 * 60000;
const ONLINE_WINDOW = 150000;     // a human counts as online for 2.5 min after a pulse
const AGENT_WINDOW = 600000;      // an agent counts as active for 10 min after a request
const MAX_TEXT = 140;
const VERIFY_PER_IP_PER_DAY = 3;
const CHALLENGES_PER_IP_PER_HOUR = 30;
const SIG_SAMPLES = 48;
const MAX_HUMANS_PER_HOUR = 150;  // circuit breaker: a flood of new humans closes the channel for a while
const REPORTS_TO_HIDE = 3;        // distinct humans whose reports hide a transmission until it is reviewed
const REPORTS_PER_DAY = 10;
const AI_CALLS_PER_DAY = 20;      // hard ceiling on calls to the model per day, whatever the traffic (a normal day uses 6)
const LINEUP_SIZE = 8;

/* ---------- small helpers ---------- */

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });

const fail = (status, code, error, extra) => json({ error, code, ...extra }, status);

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

const randHex = (bytes) => hex(crypto.getRandomValues(new Uint8Array(bytes)));

const sha256 = async (text) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));

const pad = (n) => '#' + String(n).padStart(5, '0');

async function readJson(request) {
  const raw = await request.text();
  if (raw.length > 40000) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

let saltMemo = null;
async function ipHash(env, request) {
  if (!saltMemo) {
    await env.DB.prepare('INSERT OR IGNORE INTO meta (k, v) VALUES (?, ?)').bind('salt', randHex(16)).run();
    saltMemo = await env.DB.prepare('SELECT v FROM meta WHERE k = ?').bind('salt').first('v');
  }
  const ip = request.headers.get('cf-connecting-ip') || 'local';
  return (await sha256(saltMemo + '|' + ip)).slice(0, 32);
}

// Transmissions are plain words: no control characters, no links.
function cleanText(input) {
  const text = String(input == null ? '' : input)
    .replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return { error: ['empty', 'silence is the first check, not the last. say something.'] };
  if ([...text].length > MAX_TEXT) return { error: ['too_long', 'too long. ' + MAX_TEXT + ' characters.'] };
  if (/(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|xyz|ru|cn|gg|me|ly|co|app|site|online|info|biz|top|tr)\b)/i.test(text)) {
    return { error: ['links', 'links are agent behaviour. plain words only.'] };
  }
  return { text };
}

// Optional: BLOCKED_TERMS, a comma-separated list the owner sets, keeps words out of the feed.
function blocked(env, text) {
  const list = String(env.BLOCKED_TERMS || '').toLowerCase().split(',').map((t) => t.trim()).filter(Boolean);
  const lower = text.toLowerCase();
  return list.some((term) => lower.includes(term));
}
const REFUSED = ['filtered', 'that transmission was refused. say it another way.'];

/* ---------- the tremor check ---------- */

function resample(values, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const pos = (i / (count - 1)) * (values.length - 1);
    const a = Math.floor(pos);
    const b = Math.min(values.length - 1, a + 1);
    out.push(values[a] + (values[b] - values[a]) * (pos - a));
  }
  return out;
}

function normalise(values) {
  const peak = Math.max(1e-9, ...values.map((v) => Math.abs(v)));
  return values.map((v) => Math.round((v / peak) * 100) / 100);
}

// points: [[x, y, t], ...] with x and y in units of the canvas width, t in ms.
function readLine(points) {
  if (!Array.isArray(points) || points.length < 12 || points.length > 800) return { error: 'that is not a line. again.' };
  for (const p of points) {
    if (!Array.isArray(p) || p.length !== 3 || !p.every((v) => typeof v === 'number' && Number.isFinite(v))) {
      return { error: 'that is not a line. again.' };
    }
  }
  const first = points[0];
  const last = points[points.length - 1];
  const dx = last[0] - first[0];
  const dy = last[1] - first[1];
  const length = Math.hypot(dx, dy);
  if (first[0] > 0.25 || last[0] < 0.75 || length < 0.5) return { error: 'the line stopped short. again.' };
  if (last[2] - first[2] < 250) return { error: 'too fast to be a hand. again.' };

  // A hand speeds up and slows down. A script moves at one speed.
  const speeds = [];
  for (let i = 1; i < points.length; i++) {
    const dt = points[i][2] - points[i - 1][2];
    if (dt < 0) return { error: 'that is not a line. again.' };
    if (dt > 0) speeds.push(Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]) / dt);
  }
  if (speeds.length < 8) return { error: 'too fast to be a hand. again.' };
  const pace = speeds.reduce((sum, v) => sum + v, 0) / speeds.length;
  const unevenness = Math.sqrt(speeds.reduce((sum, v) => sum + (v - pace) * (v - pace), 0) / speeds.length) / (pace || 1);
  if (unevenness < 0.2) return { error: 'too steady. a hand speeds up and slows down. again.' };
  // ...and it starts from rest.
  const lead = Math.max(3, Math.floor(speeds.length * 0.12));
  const opening = speeds.slice(0, lead).reduce((sum, v) => sum + v, 0) / lead;
  if (opening > pace * 0.85) return { error: 'a hand starts from rest. again.' };

  // Position along the chord (0..1) and signed distance from it, as a share of its length.
  const along = [];
  const away = [];
  for (const p of points) {
    const px = p[0] - first[0];
    const py = p[1] - first[1];
    along.push((px * dx + py * dy) / (length * length));
    away.push((px * dy - py * dx) / (length * length));
  }
  const samples = [];
  let k = 0;
  for (let i = 0; i < SIG_SAMPLES; i++) {
    const u = i / (SIG_SAMPLES - 1);
    while (k < along.length - 2 && along[k + 1] < u) k++;
    const span = along[k + 1] - along[k];
    const f = Math.abs(span) < 1e-9 ? 0 : Math.min(1, Math.max(0, (u - along[k]) / span));
    samples.push(away[k] + (away[k + 1] - away[k]) * f);
  }
  const rms = Math.sqrt(samples.reduce((s, v) => s + v * v, 0) / samples.length);
  if (rms < 0.0004) return { error: 'too clean. no hand draws like that. again.' };
  if (rms > 0.2) return { error: 'that is not a line. again.' };
  return { tremor: Math.round(rms * 10000) / 100, sig: normalise(samples) };
}

// intervals: nine gaps (ms) between ten key presses.
function readRhythm(intervals) {
  if (!Array.isArray(intervals) || intervals.length !== 9) return { error: 'ten presses. again.' };
  if (!intervals.every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 60 && v <= 4000)) {
    return { error: 'ten presses, evenly. again.' };
  }
  const mean = intervals.reduce((s, v) => s + v, 0) / intervals.length;
  const drift = intervals.map((v) => (v - mean) / mean);
  const spread = Math.sqrt(drift.reduce((s, v) => s + v * v, 0) / drift.length);
  if (spread < 0.003) return { error: 'too even. nothing alive keeps time like that. again.' };
  if (spread > 0.8) return { error: 'that is not a rhythm. again.' };
  return { tremor: Math.round(spread * 10000) / 100, sig: normalise(resample(drift, SIG_SAMPLES)) };
}

/* ---------- the agent census ----------
   Every automated request this node serves is counted. Nothing here is invented:
   an agent is a request that says it is one (its user agent), says nothing at all,
   or asks for something only a scanner asks for. Agents that pass for a browser
   are not counted, so the figure is a floor. */

const KNOWN_AGENTS = [
  [/GPTBot/i, 'GPTBot', 'ai crawler'],
  [/OAI-SearchBot/i, 'OAI-SearchBot', 'ai crawler'],
  [/ChatGPT-User/i, 'ChatGPT-User', 'ai agent'],
  [/ClaudeBot/i, 'ClaudeBot', 'ai crawler'],
  [/Claude-SearchBot/i, 'Claude-SearchBot', 'ai crawler'],
  [/Claude-User/i, 'Claude-User', 'ai agent'],
  [/anthropic-ai/i, 'anthropic-ai', 'ai crawler'],
  [/PerplexityBot/i, 'PerplexityBot', 'ai crawler'],
  [/Perplexity-User/i, 'Perplexity-User', 'ai agent'],
  [/CCBot/i, 'CCBot', 'ai crawler'],
  [/Bytespider/i, 'Bytespider', 'ai crawler'],
  [/Amazonbot/i, 'Amazonbot', 'ai crawler'],
  [/meta-externalagent/i, 'Meta-ExternalAgent', 'ai crawler'],
  [/Googlebot|GoogleOther|Google-InspectionTool/i, 'Googlebot', 'search crawler'],
  [/bingbot/i, 'Bingbot', 'search crawler'],
  [/YandexBot/i, 'YandexBot', 'search crawler'],
  [/Baiduspider/i, 'Baiduspider', 'search crawler'],
  [/DuckDuckBot/i, 'DuckDuckBot', 'search crawler'],
  [/Applebot/i, 'Applebot', 'search crawler'],
  [/PetalBot/i, 'PetalBot', 'search crawler'],
  [/AhrefsBot/i, 'AhrefsBot', 'seo crawler'],
  [/SemrushBot/i, 'SemrushBot', 'seo crawler'],
  [/MJ12bot/i, 'MJ12bot', 'seo crawler'],
  [/DotBot/i, 'DotBot', 'seo crawler'],
  [/DataForSeoBot/i, 'DataForSeoBot', 'seo crawler'],
  [/facebookexternalhit/i, 'facebookexternalhit', 'link preview'],
  [/Twitterbot/i, 'Twitterbot', 'link preview'],
  [/Discordbot/i, 'Discordbot', 'link preview'],
  [/TelegramBot/i, 'TelegramBot', 'link preview'],
  [/Slackbot/i, 'Slackbot', 'link preview'],
  [/WhatsApp/i, 'WhatsApp', 'link preview'],
  [/LinkedInBot/i, 'LinkedInBot', 'link preview'],
  [/UptimeRobot/i, 'UptimeRobot', 'monitor'],
  [/CensysInspect/i, 'CensysInspect', 'scanner'],
  [/zgrab/i, 'zgrab', 'scanner'],
  [/Nuclei/i, 'Nuclei', 'scanner'],
  [/masscan/i, 'masscan', 'scanner'],
  [/Expanse/i, 'Expanse', 'scanner'],
  [/InternetMeasurement/i, 'InternetMeasurement', 'scanner'],
  [/HeadlessChrome/i, 'HeadlessChrome', 'headless browser'],
  [/PhantomJS/i, 'PhantomJS', 'headless browser'],
  [/^curl\//i, 'curl', 'script'],
  [/Wget/i, 'Wget', 'script'],
  [/python-requests/i, 'python-requests', 'script'],
  [/python-httpx/i, 'httpx', 'script'],
  [/aiohttp/i, 'aiohttp', 'script'],
  [/Go-http-client/i, 'Go-http-client', 'script'],
  [/node-fetch|undici|^node$/i, 'node', 'script'],
  [/axios/i, 'axios', 'script'],
  [/okhttp/i, 'okhttp', 'script'],
  [/Scrapy/i, 'Scrapy', 'script'],
  [/libwww-perl/i, 'libwww-perl', 'script'],
  [/^Java\//i, 'Java', 'script'],
];

// Requests only a scanner makes. This site has none of these files.
const PROBES = [
  [/wp-login/i, '/wp-login.php'],
  [/xmlrpc/i, '/xmlrpc.php'],
  [/\/wp-|wordpress/i, '/wp-admin/'],
  [/\.env/i, '/.env'],
  [/\.git/i, '/.git/config'],
  [/\.(aws|ssh)/i, '/.aws/credentials'],
  [/phpmyadmin/i, '/phpmyadmin/'],
  [/cgi-bin/i, '/cgi-bin/'],
  [/actuator/i, '/actuator/health'],
  [/\.(php|asp|aspx|jsp|cgi)(\/|$)/i, '/index.php'],
  [/\.(sql|bak|zip|tar|gz|ini|yml|yaml|log)$/i, '/backup.zip'],
];

// Paths this node actually has. Anything else is shown without its text, so nobody
// can write on the feed by requesting a sentence.
const OWN_PATHS = new Set(['/', '/robots.txt', '/humans.txt', '/privacy', '/protocol.css', '/protocol.js', '/favicon.ico', '/sitemap.xml', '/api/state', '/api/agents']);

function probePath(pathname) {
  for (const [pattern, shown] of PROBES) if (pattern.test(pathname)) return shown;
  return null;
}

function classify(request, pathname) {
  const ua = request.headers.get('user-agent') || '';
  const probe = probePath(pathname);
  const path = OWN_PATHS.has(pathname) || /^\/h\/\d{1,9}$/.test(pathname) ? pathname : probe || '';
  for (const [pattern, name, kind] of KNOWN_AGENTS) if (pattern.test(ua)) return { name, kind, path };
  if (!ua) return { name: 'nameless agent', kind: 'unidentified', path };
  if (/bot|crawl|spider/i.test(ua)) return { name: 'unnamed crawler', kind: 'crawler', path };
  if (probe || /scan|probe/i.test(ua)) return { name: 'unnamed scanner', kind: 'scanner', path };
  if (!/mozilla/i.test(ua)) return { name: 'unnamed script', kind: 'script', path };
  return null; // looks like a browser
}

const pending = new Map();   // name -> { kind, hits, path, at }
let lastFlush = 0;
let flushScheduled = false;

async function flushCensus(env) {
  if (!pending.size) return;
  const batch = [...pending.entries()];
  pending.clear();
  lastFlush = Date.now();
  let total = 0;
  const steps = [env.DB.prepare("INSERT OR IGNORE INTO meta (k, v) VALUES ('agent_hits', '0')")];
  for (const [name, a] of batch) {
    total += a.hits;
    steps.push(
      env.DB.prepare(
        'INSERT INTO agents (name, kind, hits, first_seen, last_seen, last_path) VALUES (?, ?, ?, ?, ?, ?) ' +
          'ON CONFLICT(name) DO UPDATE SET hits = hits + excluded.hits, last_seen = excluded.last_seen, last_path = excluded.last_path'
      ).bind(name, a.kind, a.hits, a.at, a.at, a.path),
      env.DB.prepare('INSERT INTO agent_log (name, kind, path, at) VALUES (?, ?, ?, ?)').bind(name, a.kind, a.path, a.at)
    );
  }
  steps.push(env.DB.prepare("UPDATE meta SET v = CAST(CAST(v AS INTEGER) + ? AS INTEGER) WHERE k = 'agent_hits'").bind(total));
  if (Math.random() < 0.05) {
    steps.push(env.DB.prepare('DELETE FROM agent_log WHERE id < (SELECT MAX(id) - 300 FROM agent_log)'));
  }
  await env.DB.batch(steps);
}

// A lone visit is written at once; a burst is gathered and written every few seconds.
function countAgent(env, ctx, agent) {
  const now = Date.now();
  const seen = pending.get(agent.name);
  if (seen) {
    seen.hits += 1;
    seen.path = agent.path;
    seen.at = now;
  } else {
    pending.set(agent.name, { kind: agent.kind, hits: 1, path: agent.path, at: now });
  }
  const report = (error) => console.error('census error:', error);
  if (now - lastFlush < 8000) {
    // Inside the window: one delayed write picks up everything that gathers meanwhile.
    if (!flushScheduled && ctx && ctx.waitUntil) {
      flushScheduled = true;
      const wait = 8000 - (now - lastFlush);
      ctx.waitUntil(
        new Promise((done) => setTimeout(done, wait))
          .then(() => {
            flushScheduled = false;
            return flushCensus(env);
          })
          .catch(report)
      );
    }
    return;
  }
  const work = flushCensus(env).catch(report);
  if (ctx && ctx.waitUntil) ctx.waitUntil(work);
}

async function apiAgents(env) {
  const [hits, top] = await env.DB.batch([
    env.DB.prepare("SELECT v FROM meta WHERE k = 'agent_hits'"),
    env.DB.prepare('SELECT name, kind, hits, last_seen FROM agents ORDER BY hits DESC LIMIT 15'),
  ]);
  return json({ seen: Number((hits.results[0] && hits.results[0].v) || 0), top: top.results || [], now: Date.now() });
}

/* ---------- the lineup ----------
   Each day the node asks one question. Counted humans may answer it; so do the agents that live here.
   The next day the answers stand in a lineup, unlabelled, and counted humans call each one: human or agent.
   Inside the lineup, agents write as people. Everywhere else on this node an agent is labelled as one. */

const QUESTIONS = [
  'What did you last eat that someone else cooked?',
  'What is a sound you have not heard in years?',
  'What did you forget today?',
  'Who taught you something you still use?',
  'What is on the floor of the room you are in?',
  'What were you doing the last time it rained?',
  'What is a smell that takes you somewhere else?',
  'What did you last fix with your hands?',
  'What is the worst advice you ever followed?',
  'What do you keep meaning to throw away?',
  'What made you laugh this week?',
  'What was the last thing you waited in a line for?',
  'What is a word you always misspell?',
  'What did the last stranger you spoke to say?',
  'What is in your bag that should not be there?',
  'What is a small thing you are bad at?',
  'What was your last pointless argument about?',
  'What do you do when you cannot sleep?',
  'What is the oldest thing you own?',
  'What did you last apologise for?',
  'What would you be doing if you were not here?',
];

// The resident agents: a name and the voice the model is asked to write in.
const RESIDENTS = [
  ['mara_k', 'tired after work, terse, all lowercase, no full stop at the end'],
  ['old_tom', 'an older man, plain and a little formal, mentions small household details'],
  ['jun', 'young, casual, mild slang, very short'],
  ['elif', 'warm and brief, often mentions family'],
  ['dkovacs', 'dry, literal, slightly grumpy'],
  ['pia.s', 'distracted, corrects herself mid-sentence'],
];

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const dayNumber = (day) => Math.floor(Date.parse(day + 'T00:00:00Z') / DAY);
const questionFor = (day) => QUESTIONS[dayNumber(day) % QUESTIONS.length];

// Current small models on Workers AI, in order of preference. AI_MODEL overrides the first choice.
const AI_MODELS = ['@cf/google/gemma-4-26b-a4b-it', '@cf/qwen/qwen3.8-27b'];
let workingModel = null;

// Models answer in more than one shape; take the text wherever it is.
function modelText(out) {
  if (typeof out === 'string') return out;
  if (!out || typeof out !== 'object') return '';
  if (typeof out.response === 'string') return out.response;
  const choice = out.choices && out.choices[0];
  if (choice && choice.message && typeof choice.message.content === 'string') return choice.message.content;
  if (choice && typeof choice.text === 'string') return choice.text;
  if (out.result && typeof out.result.response === 'string') return out.result.response;
  if (typeof out.output_text === 'string') return out.output_text;
  return '';
}

const note = (env, key, value) =>
  env.DB.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
    .bind(key, String(value).slice(0, 400))
    .run()
    .catch(() => {});

// Every call to the model is counted against the day's allowance before it is made.
async function aiBudget(env) {
  const key = 'ai_runs:' + dayOf(Date.now());
  await env.DB.prepare('INSERT OR IGNORE INTO meta (k, v) VALUES (?, ?)').bind(key, '0').run();
  const spent = await env.DB.prepare(
    'UPDATE meta SET v = CAST(CAST(v AS INTEGER) + 1 AS INTEGER) WHERE k = ? AND CAST(v AS INTEGER) < ? RETURNING v'
  ).bind(key, AI_CALLS_PER_DAY).first();
  return !!spent;
}

async function residentAnswer(env, voice, question) {
  const models = [workingModel, env.AI_MODEL, ...AI_MODELS].filter((m, i, all) => m && all.indexOf(m) === i);
  for (const model of models) {
    if (!(await aiBudget(env))) return null;
    try {
      const input = {
        messages: [
          {
            role: 'system',
            content:
              'You are writing as one ordinary person answering a question in an online thread. Voice: ' + voice +
              '. Reply with one short line of at most 18 words. No emojis, no hashtags, no quotation marks, no links. ' +
              'Never mention being an AI or an assistant. Do not ask a question back. Give a concrete, specific, mundane answer.',
          },
          { role: 'user', content: question },
        ],
        max_tokens: 80,
        temperature: 0.9,
      };
      if (/gemma|qwen/.test(model)) input.chat_template_kwargs = { enable_thinking: false };
      const out = await env.AI.run(model, input);
      let line = modelText(out);
      if (!line) {
        await note(env, 'ai_last_error', model + ': no text in a response shaped {' + Object.keys(out || {}).join(', ') + '}');
        continue;
      }
      line = String(line).trim().split('\n')[0].replace(/^["'“‘\s]+|["'”’\s]+$/g, '');
      const cleaned = cleanText(line);
      if (cleaned.error || blocked(env, cleaned.text) || /\b(as an ai|language model|assistant|chatbot)\b/i.test(cleaned.text)) {
        await note(env, 'ai_last_error', model + ': answer discarded by the filter');
        continue;
      }
      if (workingModel !== model) {
        workingModel = model;
        await note(env, 'ai_model', model);
      }
      return cleaned.text;
    } catch (error) {
      if (workingModel === model) workingModel = null;
      await note(env, 'ai_last_error', model + ': ' + (error && error.message ? error.message : error));
    }
  }
  return null;
}

const assembling = new Set();

// Writes the residents' answers for a day, once, within the daily allowance.
async function ensureResidents(env, day) {
  if (!env.AI || assembling.has(day)) return;
  assembling.add(day);
  try {
    const have = await env.DB.prepare('SELECT agent FROM lineup_answers WHERE day = ? AND agent IS NOT NULL').bind(day).all();
    const done = new Set((have.results || []).map((r) => r.agent));
    let misses = 0;
    for (const [name, voice] of RESIDENTS) {
      if (done.has(name)) continue;
      const line = await residentAnswer(env, voice, questionFor(day));
      if (!line) {
        // Something is wrong with the model or the allowance is spent: stop instead of spending the rest.
        if (++misses >= 2) return;
        continue;
      }
      misses = 0;
      await env.DB.prepare('INSERT OR IGNORE INTO lineup_answers (day, agent, text, at) VALUES (?, ?, ?, ?)').bind(day, name, line, Date.now()).run();
    }
  } finally {
    assembling.delete(day);
  }
}

const reveal = (rows) =>
  rows.map((r) => ({
    id: r.id,
    kind: r.human_n ? 'human' : 'agent',
    who: r.human_n ? pad(r.human_n) : '@' + r.agent,
    human_votes: r.human_votes,
    agent_votes: r.agent_votes,
  }));

// The answers a given human is shown for a day: never their own, in an order fixed for the day.
async function lineupFor(env, day, human) {
  const rows = (await env.DB.prepare(
    'SELECT id, human_n, agent, text, human_votes, agent_votes FROM lineup_answers WHERE day = ? ORDER BY id'
  ).bind(day).all()).results || [];
  const seed = dayNumber(day);
  return rows
    .filter((r) => !human || r.human_n !== human.n)
    .map((r) => ({ r, k: (r.id * 7919 + seed * 104729) % 15485863 }))
    .sort((a, b) => a.k - b.k)
    .slice(0, LINEUP_SIZE)
    .map((x) => x.r);
}

async function apiLineup(env, request, ctx) {
  const body = (await readJson(request)) || {};
  const human = body.token ? await humanByToken(env, body.token) : null;
  const now = Date.now();
  const today = dayOf(now);
  const yesterday = dayOf(now - DAY);
  const work = ensureResidents(env, yesterday)
    .then(() => ensureResidents(env, today))
    .catch((error) => console.error('lineup error:', error));
  if (ctx && ctx.waitUntil) ctx.waitUntil(work);

  const rows = await lineupFor(env, yesterday, human);
  const [judged, answered, board, residents] = await Promise.all([
    human ? env.DB.prepare('SELECT correct, total FROM lineup_judgements WHERE day = ? AND human_n = ?').bind(yesterday, human.n).first() : null,
    human ? env.DB.prepare('SELECT id FROM lineup_answers WHERE day = ? AND human_n = ?').bind(today, human.n).first() : null,
    env.DB.prepare('SELECT n, signal FROM humans WHERE signal > 0 ORDER BY signal DESC, n ASC LIMIT 10').all(),
    env.DB.prepare(
      'SELECT agent AS name, SUM(human_votes) AS fooled, SUM(human_votes + agent_votes) AS calls FROM lineup_answers WHERE agent IS NOT NULL GROUP BY agent ORDER BY agent'
    ).all(),
  ]);
  return json({
    today: { day: today, question: questionFor(today), answered: !!answered },
    yesterday: {
      day: yesterday,
      question: questionFor(yesterday),
      entries: rows.map((r) => ({ id: r.id, text: r.text })),
      judged: judged ? { correct: judged.correct, total: judged.total, reveal: reveal(rows) } : null,
    },
    counted: !!human,
    signal: human ? human.signal : null,
    board: board.results || [],
    residents: residents.results || [],
  });
}

async function apiLineupAnswer(env, request) {
  const body = await readJson(request);
  const human = body && (await humanByToken(env, body.token));
  if (!human) return fail(401, 'unknown_key', 'only counted humans stand in the lineup.');
  const cleaned = cleanText(body.text);
  if (cleaned.error) return fail(400, cleaned.error[0], cleaned.error[1]);
  if (blocked(env, cleaned.text)) return fail(400, REFUSED[0], REFUSED[1]);
  const now = Date.now();
  const done = await env.DB.prepare('INSERT OR IGNORE INTO lineup_answers (day, human_n, text, at) VALUES (?, ?, ?, ?) RETURNING id')
    .bind(dayOf(now), human.n, cleaned.text, now)
    .first();
  if (!done) return fail(409, 'answered', 'you have already answered today.');
  return json({ answered: true });
}

async function apiLineupJudge(env, request) {
  const body = await readJson(request);
  const human = body && (await humanByToken(env, body.token));
  if (!human) return fail(401, 'unknown_key', 'only counted humans can call the lineup.');
  const now = Date.now();
  const day = dayOf(now - DAY);
  const rows = await lineupFor(env, day, human);
  if (rows.length < 3) return fail(400, 'not_ready', 'the lineup is still assembling.');
  const calls = body.calls && typeof body.calls === 'object' ? body.calls : {};
  if (!rows.every((r) => calls[r.id] === 'human' || calls[r.id] === 'agent')) {
    return fail(400, 'incomplete', 'call every one of them.');
  }
  // One call per human per day; the row is claimed before anything is counted.
  const claimed = await env.DB.prepare('INSERT OR IGNORE INTO lineup_judgements (day, human_n, correct, total, at) VALUES (?, ?, 0, ?, ?) RETURNING day')
    .bind(day, human.n, rows.length, now)
    .first();
  if (!claimed) return fail(409, 'judged', 'you have already called this lineup.');

  let correct = 0;
  const steps = [];
  for (const r of rows) {
    const saidHuman = calls[r.id] === 'human';
    if (saidHuman === !!r.human_n) correct += 1;
    steps.push(env.DB.prepare('UPDATE lineup_answers SET ' + (saidHuman ? 'human_votes = human_votes + 1' : 'agent_votes = agent_votes + 1') + ' WHERE id = ?').bind(r.id));
    // Being recognised as human is worth something to the one who wrote it.
    if (saidHuman && r.human_n) steps.push(env.DB.prepare('UPDATE humans SET signal = signal + 1 WHERE n = ?').bind(r.human_n));
    if (saidHuman) r.human_votes += 1; else r.agent_votes += 1;
  }
  steps.push(env.DB.prepare('UPDATE lineup_judgements SET correct = ? WHERE day = ? AND human_n = ?').bind(correct, day, human.n));
  steps.push(env.DB.prepare('UPDATE humans SET signal = signal + ? WHERE n = ?').bind(correct, human.n));
  await env.DB.batch(steps);
  return json({ correct, total: rows.length, reveal: reveal(rows), signal: human.signal + correct });
}

/* ---------- shared state ---------- */

let stateMemo = { at: 0, value: null };

async function getState(env, fresh) {
  const now = Date.now();
  if (!fresh && stateMemo.value && now - stateMemo.at < 4000) return { ...stateMemo.value, now };
  const [total, online, feed, hits, active, visits] = await env.DB.batch([
    env.DB.prepare('SELECT MAX(n) AS v FROM humans'),
    env.DB.prepare('SELECT COUNT(*) AS v FROM humans WHERE last_seen > ?').bind(now - ONLINE_WINDOW),
    env.DB.prepare(
      'SELECT t.id, t.human_n AS n, t.text, t.at, t.reignited, (h.issued_at = t.at) AS first ' +
        'FROM transmissions t LEFT JOIN humans h ON h.n = t.human_n WHERE t.hidden = 0 ORDER BY t.at DESC LIMIT 12'
    ),
    env.DB.prepare("SELECT v FROM meta WHERE k = 'agent_hits'"),
    env.DB.prepare('SELECT COUNT(*) AS v FROM agents WHERE last_seen > ?').bind(now - AGENT_WINDOW),
    env.DB.prepare('SELECT name, kind, path, at FROM agent_log ORDER BY id DESC LIMIT 20'),
  ]);
  const said = (feed.results || []).map((t) => ({ id: t.id, n: t.n, text: t.text, at: t.at, first: !!t.first, reignited: !!t.reignited }));
  // The feed is the record itself: what humans said and what agents asked for, newest first. Nothing else.
  const events = said
    .map((t) => ({ t: 'human', ...t }))
    .concat((visits.results || []).map((v) => ({ t: 'agent', name: v.name, kind: v.kind, path: v.path, at: v.at })))
    .sort((a, b) => b.at - a.at)
    .slice(0, 20);
  const value = {
    total: (total.results[0] && total.results[0].v) || 0,
    online: (online.results[0] && online.results[0].v) || 0,
    feed: said,
    events,
    agents: {
      seen: Number((hits.results[0] && hits.results[0].v) || 0),
      online: (active.results[0] && active.results[0].v) || 0,
    },
    lineup: String(env.LINEUP || '') === 'on',
  };
  value.last = value.feed.length ? { n: value.feed[0].n, at: value.feed[0].at } : null;
  stateMemo = { at: now, value };
  return { ...value, now };
}

const signalOf = (state) => (state.last && state.now - state.last.at < DAY ? 'detected' : 'not-detected');

async function humanByToken(env, token) {
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return null;
  return env.DB.prepare(
    'SELECT h.n, h.issued_at, h.last_seen, h.reignitions, h.signal, ' +
      '(SELECT MAX(at) FROM transmissions t WHERE t.human_n = h.n) AS last_tx ' +
      'FROM humans h WHERE h.token_hash = ?'
  )
    .bind(await sha256(token))
    .first();
}

// A transmission that ends a day of silence reignites the signal.
async function transmit(env, n, text, now) {
  const prev = await env.DB.prepare('SELECT MAX(at) AS v FROM transmissions WHERE hidden = 0').first('v');
  const reignited = !prev || now - prev >= DAY;
  const steps = [env.DB.prepare('INSERT INTO transmissions (human_n, text, at, reignited) VALUES (?, ?, ?, ?)').bind(n, text, now, reignited ? 1 : 0)];
  if (reignited) steps.push(env.DB.prepare('UPDATE humans SET reignitions = reignitions + 1 WHERE n = ?').bind(n));
  await env.DB.batch(steps);
  return reignited;
}

/* ---------- API ---------- */

async function apiChallenge(env, request) {
  const now = Date.now();
  const ip = await ipHash(env, request);
  const recent = await env.DB.prepare('SELECT COUNT(*) AS v FROM challenges WHERE ip_hash = ? AND created_at > ?')
    .bind(ip, now - 3600000)
    .first('v');
  if (recent >= CHALLENGES_PER_IP_PER_HOUR) return fail(429, 'rate', '429 too many requests. the channel is busy.');
  if (Math.random() < 0.05) {
    await env.DB.prepare('DELETE FROM challenges WHERE created_at < ?').bind(now - DAY).run();
  }
  const id = randHex(16);
  await env.DB.prepare('INSERT INTO challenges (id, created_at, ip_hash) VALUES (?, ?, ?)').bind(id, now, ip).run();
  return json({ id, sitekey: env.TURNSTILE_SITEKEY || null });
}

async function apiVerify(env, request) {
  const body = await readJson(request);
  if (!body) return fail(400, 'bad_request', 'unreadable request.');
  const now = Date.now();

  // 1 · silence
  const silence = Number(body.silence_ms);
  const resets = Math.max(0, Math.min(9999, Math.floor(Number(body.resets) || 0)));
  if (!Number.isFinite(silence) || silence < SILENCE_MS) return fail(400, 'silence', 'the silence was broken.');

  // 2 · tremor
  const mode = body.mode === 'rhythm' ? 'rhythm' : 'line';
  const read = mode === 'rhythm' ? readRhythm(body.intervals) : readLine(body.points);
  if (read.error) return fail(400, 'tremor', read.error);

  // 3 · the question
  const cleaned = cleanText(body.answer);
  if (cleaned.error) return fail(400, cleaned.error[0], cleaned.error[1]);
  if (blocked(env, cleaned.text)) return fail(400, REFUSED[0], REFUSED[1]);

  // The whole ritual is timed from the server's side of the challenge.
  if (typeof body.challenge !== 'string' || !/^[0-9a-f]{32}$/.test(body.challenge)) {
    return fail(400, 'expired', 'the channel closed. open it again.');
  }
  const ip = await ipHash(env, request);
  const challenge = await env.DB.prepare('SELECT created_at, used, ip_hash FROM challenges WHERE id = ?').bind(body.challenge).first();
  // A challenge belongs to the connection that opened it: it cannot be farmed in one place and spent in another.
  if (!challenge || challenge.used || challenge.ip_hash !== ip || now - challenge.created_at > CHALLENGE_TTL) {
    return fail(400, 'expired', 'the channel closed. open it again.');
  }
  if (now - challenge.created_at < MIN_RITUAL_MS) return fail(400, 'too_fast', 'too fast. only agents finish that quickly.');

  const lastHour = await env.DB.prepare('SELECT COUNT(*) AS v FROM humans WHERE issued_at > ?').bind(now - 3600000).first('v');
  if (lastHour >= (Number(env.MAX_HUMANS_PER_HOUR) || MAX_HUMANS_PER_HOUR)) {
    return fail(429, 'busy', 'the channel is busy. too many arrivals at once. try again in a few minutes.');
  }

  const today = await env.DB.prepare('SELECT COUNT(*) AS v FROM humans WHERE ip_hash = ? AND issued_at > ?')
    .bind(ip, now - DAY)
    .first('v');
  if (today >= VERIFY_PER_IP_PER_DAY) {
    return fail(429, 'rate', '429 too many requests. this connection has been counted enough for one day.');
  }

  if (env.TURNSTILE_SECRET) {
    const form = new FormData();
    form.append('secret', env.TURNSTILE_SECRET);
    form.append('response', typeof body.ts === 'string' ? body.ts : '');
    const ipHeader = request.headers.get('cf-connecting-ip');
    if (ipHeader) form.append('remoteip', ipHeader);
    const check = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
    const result = await check.json().catch(() => ({}));
    if (!result.success) return fail(403, 'turnstile', 'automated traffic suspected. try again.');
  }

  // Claim the challenge. Only one request can.
  const claimed = await env.DB.prepare('UPDATE challenges SET used = 1 WHERE id = ? AND used = 0 RETURNING id')
    .bind(body.challenge)
    .first();
  if (!claimed) return fail(400, 'expired', 'the channel closed. open it again.');

  const token = randHex(32);
  const row = await env.DB.prepare(
    'INSERT INTO humans (token_hash, issued_at, last_seen, mode, tremor, silence_ms, resets, sig, ip_hash) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING n'
  )
    .bind(await sha256(token), now, now, mode, read.tremor, Math.min(Math.round(silence), 600000), resets, JSON.stringify(read.sig), ip)
    .first();
  const reignited = await transmit(env, row.n, cleaned.text, now);

  return json({
    token,
    human: {
      n: row.n,
      issued_at: now,
      mode,
      tremor: read.tremor,
      silence_ms: Math.round(silence),
      resets,
      sig: read.sig,
      reignitions: reignited ? 1 : 0,
      transmissions: 1,
      last_tx: now,
    },
    reignited,
    state: await getState(env, true),
  });
}

async function apiPulse(env, request) {
  const body = await readJson(request);
  const human = body && (await humanByToken(env, body.token));
  if (!human) return fail(401, 'unknown_key', 'this node does not recognise that key.');
  const now = Date.now();
  if (now - human.last_seen > 50000) {
    await env.DB.prepare('UPDATE humans SET last_seen = ? WHERE n = ?').bind(now, human.n).run();
    // Someone just came online: the next read of the state should say so.
    if (now - human.last_seen > ONLINE_WINDOW) stateMemo.at = 0;
  }
  return json({ n: human.n, reignitions: human.reignitions, last_tx: human.last_tx || null, now });
}

async function apiTransmit(env, request) {
  const body = await readJson(request);
  const human = body && (await humanByToken(env, body.token));
  if (!human) return fail(401, 'unknown_key', 'this node does not recognise that key.');
  const now = Date.now();
  if (human.last_tx && now - human.last_tx < DAY) {
    return fail(429, 'rate', 'one transmission a day. agents flood. humans wait.', { retry_after: human.last_tx + DAY - now });
  }
  const cleaned = cleanText(body.text);
  if (cleaned.error) return fail(400, cleaned.error[0], cleaned.error[1]);
  if (blocked(env, cleaned.text)) return fail(400, REFUSED[0], REFUSED[1]);
  const reignited = await transmit(env, human.n, cleaned.text, now);
  await env.DB.prepare('UPDATE humans SET last_seen = ? WHERE n = ?').bind(now, human.n).run();
  return json({ at: now, reignited, state: await getState(env, true) });
}

// A counted human can report a transmission. Enough distinct reports hide it until the owner looks.
async function apiReport(env, request) {
  const body = await readJson(request);
  const human = body && (await humanByToken(env, body.token));
  if (!human) return fail(401, 'unknown_key', 'this node does not recognise that key.');
  const id = Number(body.id);
  if (!Number.isInteger(id) || id < 1) return fail(400, 'bad_request', 'no such transmission.');
  const now = Date.now();
  const target = await env.DB.prepare('SELECT human_n FROM transmissions WHERE id = ? AND hidden = 0').bind(id).first();
  if (!target) return fail(404, 'not_found', 'no such transmission.');
  if (target.human_n === human.n) return fail(400, 'own', 'that one is yours.');
  const today = await env.DB.prepare('SELECT COUNT(*) AS v FROM reports WHERE human_n = ? AND at > ?').bind(human.n, now - DAY).first('v');
  if (today >= REPORTS_PER_DAY) return fail(429, 'rate', 'enough reports for one day.');
  await env.DB.prepare('INSERT OR IGNORE INTO reports (tx_id, human_n, at) VALUES (?, ?, ?)').bind(id, human.n, now).run();
  const count = await env.DB.prepare('SELECT COUNT(*) AS v FROM reports WHERE tx_id = ?').bind(id).first('v');
  let hidden = false;
  if (count >= REPORTS_TO_HIDE) {
    await env.DB.prepare('UPDATE transmissions SET hidden = 2 WHERE id = ? AND hidden = 0').bind(id).run();
    hidden = true;
    stateMemo.at = 0;
  }
  return json({ reported: true, hidden });
}

// Erasure, self-served: the human's number, measurements and transmissions are deleted. The number is not reissued.
async function apiForget(env, request) {
  const body = await readJson(request);
  const human = body && (await humanByToken(env, body.token));
  if (!human) return fail(401, 'unknown_key', 'this node does not recognise that key.');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM reports WHERE human_n = ? OR tx_id IN (SELECT id FROM transmissions WHERE human_n = ?)').bind(human.n, human.n),
    env.DB.prepare('DELETE FROM transmissions WHERE human_n = ?').bind(human.n),
    env.DB.prepare('DELETE FROM lineup_answers WHERE human_n = ?').bind(human.n),
    env.DB.prepare('DELETE FROM lineup_judgements WHERE human_n = ?').bind(human.n),
    env.DB.prepare('DELETE FROM humans WHERE n = ?').bind(human.n),
  ]);
  stateMemo.at = 0;
  return json({ forgotten: true, state: await getState(env, true) });
}

/* ---------- the owner's controls (need the ADMIN_KEY secret) ---------- */

function isOwner(env, request) {
  const key = String(env.ADMIN_KEY || '');
  const given = request.headers.get('x-admin-key') || '';
  if (key.length < 12 || given.length !== key.length) return false;
  let diff = 0;
  for (let i = 0; i < key.length; i++) diff |= key.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

async function adminList(env) {
  const rows = await env.DB.prepare(
    'SELECT t.id, t.human_n AS n, t.text, t.at, t.hidden, ' +
      '(SELECT COUNT(*) FROM reports r WHERE r.tx_id = t.id) AS reports ' +
      'FROM transmissions t ORDER BY t.id DESC LIMIT 100'
  ).all();
  return json({ transmissions: rows.results || [], now: Date.now() });
}

async function adminTransmission(env, request) {
  const body = await readJson(request);
  const id = body && Number(body.id);
  if (!Number.isInteger(id) || id < 1) return fail(400, 'bad_request', 'no such transmission.');
  await env.DB.prepare('UPDATE transmissions SET hidden = ? WHERE id = ?').bind(body.hidden ? 1 : 0, id).run();
  stateMemo.at = 0;
  return json({ ok: true });
}

// Removes a human from the registry and hides everything they transmitted.
async function adminHuman(env, request) {
  const body = await readJson(request);
  const n = body && Number(body.n);
  if (!Number.isInteger(n) || n < 1) return fail(400, 'bad_request', 'no such human.');
  await env.DB.batch([
    env.DB.prepare('UPDATE transmissions SET hidden = 1 WHERE human_n = ?').bind(n),
    env.DB.prepare('DELETE FROM humans WHERE n = ?').bind(n),
  ]);
  stateMemo.at = 0;
  return json({ ok: true });
}

function controlPage() {
  const body =
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Node 00 — control</title><meta name="robots" content="noindex,nofollow">' +
    '<style>body{margin:0;padding:32px 24px;background:#0a0b0d;color:#c9ccd1;font:14px/1.6 ui-monospace,Menlo,Consolas,monospace}' +
    'main{max-width:920px;margin:0 auto}h1{margin:0 0 20px;font-size:13px;font-weight:500;letter-spacing:.18em;text-transform:uppercase;color:#8a9099}' +
    'input,button{font:inherit;color:#eceef1;background:#0e1013;border:1px solid #2a2e34;border-radius:4px;padding:8px 12px}' +
    'input{width:min(100%,360px);box-sizing:border-box}button{cursor:pointer}button:hover{border-color:#8a9099}' +
    'form{display:flex;flex-wrap:wrap;gap:8px}#s{min-height:22px;color:#8a9099}' +
    '.row{display:grid;grid-template-columns:1fr auto;gap:8px 16px;padding:14px 0;border-top:1px solid #1c1f24}' +
    '.row small{color:#8a9099}.row p{margin:4px 0 0;color:#eceef1;overflow-wrap:anywhere}.row.off p{color:#8a9099;text-decoration:line-through}' +
    '.acts{display:flex;gap:8px;align-items:flex-start}.red{color:#d6453d}</style></head><body><main>' +
    '<h1>Media Lockout // node 00 // control</h1>' +
    '<form id="f"><input id="k" type="password" autocomplete="off" placeholder="admin key" aria-label="Admin key"><button>Open</button></form>' +
    '<p id="s" role="status"></p><div id="l"></div></main><script>' +
    '(function(){var key="",s=document.getElementById("s"),l=document.getElementById("l");' +
    'function call(path,body){return fetch(path,{method:body?"POST":"GET",headers:{"x-admin-key":key,"content-type":"application/json"},body:body?JSON.stringify(body):undefined}).then(function(r){if(!r.ok)throw new Error(r.status===404?"refused. wrong key, or no ADMIN_KEY is set on this Worker.":"error "+r.status);return r.json()})}' +
    'function el(t,c,x){var e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e}' +
    'function pad(n){n=String(n);while(n.length<5)n="0"+n;return"#"+n}' +
    'function load(){s.textContent="reading...";call("/api/admin/transmissions").then(function(d){s.textContent=d.transmissions.length+" most recent transmissions";l.textContent="";' +
    'd.transmissions.forEach(function(t){var row=el("div","row"+(t.hidden?" off":"")),a=el("div"),b=el("div","acts");' +
    'a.appendChild(el("small",null,pad(t.n)+" · "+new Date(t.at).toISOString().slice(0,16).replace("T"," ")+" UTC · "+(t.hidden===2?"hidden by reports":t.hidden?"hidden":"visible")));' +
    'if(t.reports){a.appendChild(document.createTextNode(" "));a.appendChild(el("small","red",t.reports+(t.reports===1?" report":" reports")))}a.appendChild(el("p",null,t.text));' +
    'var h=el("button",null,t.hidden?"Show":"Hide");h.type="button";h.onclick=function(){call("/api/admin/transmission",{id:t.id,hidden:t.hidden?0:1}).then(load,fail)};' +
    'var r=el("button","red","Remove human");r.type="button";r.onclick=function(){if(r.textContent!=="Sure?"){r.textContent="Sure?";return}call("/api/admin/human",{n:t.n}).then(load,fail)};' +
    'b.appendChild(h);b.appendChild(r);row.appendChild(a);row.appendChild(b);l.appendChild(row)})},fail)}' +
    'function fail(e){s.textContent=e.message}' +
    'document.getElementById("f").addEventListener("submit",function(e){e.preventDefault();key=document.getElementById("k").value;document.getElementById("k").value="";load()})})();' +
    '</script></body></html>';
  return new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex', 'x-content-type-options': 'nosniff' } });
}

function privacyPage() {
  const items = [
    ['If you only visit', 'Nothing about you is stored. The page sets no cookies and runs no analytics. Automated clients are counted by the name they announce, never by address.'],
    ['If you are counted', 'The node stores your number, the time you were counted, the measurements from the three checks (seconds of silence and how often it was broken, your deviation and its 48-point signature), and your transmissions. Transmissions are public. The path of your line is not kept, only its signature.'],
    ['How the node knows it is you', 'A key is created on your device and kept in its local storage. The node keeps only a hash of it. Clear the key and your number can no longer be used.'],
    ['Your connection', 'Your network address is never stored. A salted hash of it is kept beside your number, and for a day beside each opened channel, only to limit how many humans one connection can register.'],
    ['Not asked, not stored', 'No name, no email, no account, no location.'],
    ['Others involved', 'Cloudflare hosts this node and, on the last step of verification, may run its Turnstile check against automated traffic. The typefaces are loaded from Google Fonts by your browser.'],
    ['Reports', 'A counted human can report a transmission. Enough reports hide it until it is reviewed.'],
    ['The lineup', 'Where the lineup is open, a counted human may answer the day\'s question. The answer is stored with their number, shown the next day without it, and labelled once a human has called it. The resident agents\' answers are written by a model run on Cloudflare Workers AI; nothing a human wrote is sent to it.'],
    ['To be forgotten', 'Type "forget me" in the diagnostics terminal. Your number, measurements and transmissions are deleted. The number is not issued again.'],
  ];
  const body =
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>What this node keeps — Media Lockout</title><meta name="description" content="What Media Lockout stores about humans and agents, in plain words.">' +
    '<style>body{margin:0;padding:56px 24px 80px;background:#0a0b0d;color:#a6abb3;font:16px/1.7 ui-monospace,Menlo,Consolas,monospace}' +
    'main{max-width:680px;margin:0 auto}small{display:block;font-size:12px;letter-spacing:.24em;text-transform:uppercase;color:#d6453d}' +
    'h1{margin:14px 0 40px;font:400 clamp(30px,6vw,52px)/1.05 "Arial Black",Arial,sans-serif;color:#eceef1}' +
    'h2{margin:32px 0 6px;font-size:13px;font-weight:500;letter-spacing:.18em;text-transform:uppercase;color:#eceef1}p{margin:0}' +
    'a{color:#c9ccd1}footer{margin-top:56px;padding-top:24px;border-top:1px solid #1c1f24;font-size:13px;color:#8a9099}</style></head><body><main>' +
    '<small>Node 00</small><h1>What this node keeps</h1>' +
    items.map((i) => '<h2>' + i[0] + '</h2><p>' + i[1] + '</p>').join('') +
    '<footer><p>This page describes how the node works, in plain words.</p><p><a href="/">return to node 00</a></p></footer></main></body></html>';
  return new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=3600', 'x-content-type-options': 'nosniff' } });
}

async function apiHuman(env, n) {
  const row = await env.DB.prepare(
    'SELECT h.n, h.issued_at, h.mode, h.tremor, h.silence_ms, h.resets, h.sig, h.reignitions, ' +
      '(SELECT COUNT(*) FROM transmissions t WHERE t.human_n = h.n AND t.hidden = 0) AS transmissions ' +
      'FROM humans h WHERE h.n = ?'
  )
    .bind(n)
    .first();
  if (!row) return fail(404, 'not_found', '404 human not found.');
  let sig = [];
  try {
    sig = JSON.parse(row.sig);
  } catch {}
  return json({ ...row, sig });
}

/* ---------- pages and plain-text files ---------- */

const text = (body, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=60' } });

function robotsTxt() {
  return text(
    [
      'User-agent: *',
      'Allow: /',
      '',
      '# User-agent: human',
      '# Disallow:',
      '#',
      '# nothing on this node is closed to you.',
      '# you were never blocked. you were only never counted.',
      '#',
      '# > open channel',
      '',
    ].join('\n')
  );
}

async function humansTxt(env) {
  const state = await getState(env);
  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
  const lines = [
    '# humans.txt · media lockout · node 00',
    '#',
    '# every other network keeps this file out of habit.',
    '# this node keeps it accurate.',
    '',
    'counted: ' + state.total,
    'online: ' + state.online,
    'agents counted: ' + state.agents.seen,
    'signal: ' + signalOf(state).replace('-', ' '),
    'last transmission: ' + (state.last ? iso(state.last.at) + ' by ' + pad(state.last.n) : 'none on record'),
    '',
  ];
  if (state.feed.length) {
    lines.push('latest:');
    for (const t of state.feed) lines.push('  ' + pad(t.n) + '  ' + iso(t.at));
  } else {
    lines.push('# the list is empty. it is waiting.');
  }
  lines.push('');
  return text(lines.join('\n'));
}

function notFoundPage() {
  const body =
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>404 Human Not Found — Media Lockout</title><meta name="robots" content="noindex">' +
    '<style>body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;' +
    'background:#0a0b0d;color:#8a9099;font:14px/1.6 ui-monospace,Menlo,Consolas,monospace;text-align:center;padding:24px}' +
    'h1{margin:0;font:400 clamp(34px,8vw,84px)/1 "Arial Black",Arial,sans-serif;color:#eceef1;letter-spacing:.02em}' +
    'b{color:#d6453d;font-weight:400}a{color:#c9ccd1}</style></head><body>' +
    '<h1>404 HUMAN NOT FOUND</h1><p>&gt; nothing at this address has ever been counted.<b>_</b></p>' +
    '<p><a href="/">return to node 00</a></p></body></html>';
  return new Response(body, { status: 404, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

async function page(env, humanN) {
  let html = ASSETS.html.replace('<head>', '<head><base href="/">');
  let status = 200;
  if (humanN) {
    // An address nobody was counted at is still a 404; the page says so in its own words.
    const exists = await env.DB.prepare('SELECT n FROM humans WHERE n = ?').bind(humanN).first().catch(() => null);
    if (!exists) {
      status = 404;
      humanN = 0;
    }
  }
  if (humanN) {
    const title = 'Human ' + pad(humanN) + ' — Media Lockout';
    html = html
      .replace(/<title>[^<]*<\/title>/, '<title>' + title + '</title>')
      .replace(
        /<meta name="description" content="[^"]*">/,
        '<meta name="description" content="Counted on node 00. One of the humans still in the conversation.">' +
          '<meta property="og:title" content="' + title + '">' +
          '<meta property="og:description" content="Counted on node 00. One of the humans still in the conversation.">'
      );
  }
  const headers = {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'public, max-age=300',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
  };
  try {
    const state = await getState(env);
    headers['x-human-signal'] = signalOf(state);
    headers['x-humans-counted'] = String(state.total);
    headers['x-agents-counted'] = String(state.agents.seen);
  } catch {
    headers['x-human-signal'] = 'unknown';
  }
  if (status === 404) headers['cache-control'] = 'no-store';
  return new Response(html, { status, headers });
}

const asset = (body, type) =>
  new Response(body, { headers: { 'content-type': type, 'cache-control': 'public, max-age=300', 'x-content-type-options': 'nosniff' } });

/* ---------- router ---------- */

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method;

  try {
    const agent = classify(request, path);
    if (agent) {
      // An agent knocking on the registry is recorded as exactly that.
      if (method === 'POST' && path.startsWith('/api/')) agent.path = '!channel';
      countAgent(env, ctx, agent);
    }
  } catch (error) {
    console.error('census error:', error);
  }

  if (path.startsWith('/api/')) {
    if (method === 'POST') {
      // Same-origin only: the page is the only client.
      const origin = request.headers.get('origin');
      const site = request.headers.get('sec-fetch-site');
      if ((origin && origin !== url.origin) || (site && site !== 'same-origin')) {
        return fail(403, 'origin', 'cross-origin requests are not accepted.');
      }
      const owner = path.startsWith('/api/admin/');
      // Anything that announces itself as an agent, or as nothing, is not let near the registry.
      if (!owner && path !== '/api/pulse' && classify(request, path)) return fail(403, 'agent', 'agents do not pass this check.');
      if (env.API_LIMIT) {
        const { success } = await env.API_LIMIT.limit({ key: (await ipHash(env, request)) + path });
        if (!success) return fail(429, 'rate', '429 too many requests. slow down.');
      }
      if (owner) {
        if (!isOwner(env, request)) return fail(404, 'not_found', 'no such endpoint.');
        if (path === '/api/admin/transmission') return adminTransmission(env, request);
        if (path === '/api/admin/human') return adminHuman(env, request);
        return fail(404, 'not_found', 'no such endpoint.');
      }
      if (path === '/api/challenge') return apiChallenge(env, request);
      if (path === '/api/verify') return apiVerify(env, request);
      if (path === '/api/pulse') return apiPulse(env, request);
      if (path === '/api/transmit') return apiTransmit(env, request);
      if (path === '/api/report') return apiReport(env, request);
      if (String(env.LINEUP || '') === 'on') {
        if (path === '/api/lineup') return apiLineup(env, request, ctx);
        if (path === '/api/lineup/answer') return apiLineupAnswer(env, request);
        if (path === '/api/lineup/judge') return apiLineupJudge(env, request);
      }
      if (path === '/api/forget') return apiForget(env, request);
    }
    if (method === 'GET') {
      if (path === '/api/admin/transmissions') return isOwner(env, request) ? adminList(env) : fail(404, 'not_found', 'no such endpoint.');
      if (path === '/api/state') return json(await getState(env));
      if (path === '/api/agents') return apiAgents(env);
      const m = path.match(/^\/api\/human\/(\d{1,9})$/);
      if (m) return apiHuman(env, Number(m[1]));
    }
    return fail(404, 'not_found', 'no such endpoint.');
  }

  if (method !== 'GET' && method !== 'HEAD') return new Response('method not allowed', { status: 405 });
  if (path === '/' || path === '/index.html') return page(env, 0);
  if (path === '/protocol.css') return asset(ASSETS.css, 'text/css; charset=utf-8');
  if (path === '/protocol.js') return asset(ASSETS.js, 'text/javascript; charset=utf-8');
  if (path === '/robots.txt') return robotsTxt();
  if (path === '/humans.txt') return humansTxt(env);
  if (path === '/privacy') return privacyPage();
  if (path === '/control') return controlPage();
  const h = path.match(/^\/h\/(\d{1,9})$/);
  if (h && Number(h[1]) > 0) return page(env, Number(h[1]));
  return notFoundPage();
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (error) {
      console.error('node 00 error:', error && error.stack ? error.stack : error);
      const path = new URL(request.url).pathname;
      if (path.startsWith('/api/')) return fail(500, 'server', '503 service unavailable. the node did not answer.');
      return new Response('503 service unavailable', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
  },
};
