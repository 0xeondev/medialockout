/* Media Lockout · node 00 · the human channel
   Live counters, the signal, the feed, the diagnostics terminal and the verification ritual.
   No dependencies. Everything a visitor types is written to the page with textContent. */
(function () {
  'use strict';

  var DAY = 86400000;
  var SILENCE_MS = 7000;
  var SIG_SAMPLES = 48;
  var MAX_TEXT = 140;
  var RED = '#d6453d';
  var HEAD = '#eceef1';
  var MUTED = '#8a9099';

  // Opened from disk (or with ?demo) there is no registry to talk to, so the page keeps one in this browser.
  var LOCAL = window.ML_LOCAL === true || location.protocol === 'file:' || /[?&]demo\b/.test(location.search);
  var KEY = LOCAL ? 'ml.local.key' : 'ml.key';

  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }
  var VIA = 'ml.via';
  function load(key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; } }
  function save(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {} }

  var me = load(KEY);        // { token, human }
  var known = !!me;          // false once the node says it does not recognise the key
  var state = null;          // last state from the node
  var skew = 0;              // node clock minus this clock

  /* ---------- formatting ---------- */

  function two(n) { return (n < 10 ? '0' : '') + n; }
  function pad(n) { var s = String(n); while (s.length < 5) s = '0' + s; return '#' + s; }
  function now() { return Date.now() + skew; }
  function clock(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    return two(Math.floor(s / 3600)) + ':' + two(Math.floor((s % 3600) / 60)) + ':' + two(s % 60);
  }
  function ago(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h';
    return Math.floor(s / 86400) + 'd';
  }
  function stamp(ms) { return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'; }
  function ordinal(n) {
    var t = n % 100;
    if (t >= 11 && t <= 13) return n + 'th';
    return n + (['th', 'st', 'nd', 'rd'][n % 10] || 'th');
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  /* ---------- the tremor check (the node repeats this on its side) ---------- */

  function resample(values, count) {
    var out = [];
    for (var i = 0; i < count; i++) {
      var pos = (i / (count - 1)) * (values.length - 1);
      var a = Math.floor(pos);
      var b = Math.min(values.length - 1, a + 1);
      out.push(values[a] + (values[b] - values[a]) * (pos - a));
    }
    return out;
  }
  function normalise(values) {
    var peak = 1e-9;
    values.forEach(function (v) { peak = Math.max(peak, Math.abs(v)); });
    return values.map(function (v) { return Math.round((v / peak) * 100) / 100; });
  }
  function readLine(points) {
    if (!points || points.length < 12) return { error: 'that is not a line. again.' };
    var first = points[0];
    var last = points[points.length - 1];
    var dx = last[0] - first[0];
    var dy = last[1] - first[1];
    var length = Math.sqrt(dx * dx + dy * dy);
    if (first[0] > 0.25 || last[0] < 0.75 || length < 0.5) return { error: 'the line stopped short. again.' };
    if (last[2] - first[2] < 250) return { error: 'too fast to be a hand. again.' };
    var speeds = [];
    for (var j = 1; j < points.length; j++) {
      var dt = points[j][2] - points[j - 1][2];
      if (dt < 0) return { error: 'that is not a line. again.' };
      if (dt > 0) {
        var sx = points[j][0] - points[j - 1][0];
        var sy = points[j][1] - points[j - 1][1];
        speeds.push(Math.sqrt(sx * sx + sy * sy) / dt);
      }
    }
    if (speeds.length < 8) return { error: 'too fast to be a hand. again.' };
    var pace = speeds.reduce(function (t, v) { return t + v; }, 0) / speeds.length;
    var unevenness = Math.sqrt(speeds.reduce(function (t, v) { return t + (v - pace) * (v - pace); }, 0) / speeds.length) / (pace || 1);
    if (unevenness < 0.2) return { error: 'too steady. a hand speeds up and slows down. again.' };
    var lead = Math.max(3, Math.floor(speeds.length * 0.12));
    var opening = speeds.slice(0, lead).reduce(function (t, v) { return t + v; }, 0) / lead;
    if (opening > pace * 0.85) return { error: 'a hand starts from rest. again.' };
    var along = [];
    var away = [];
    points.forEach(function (p) {
      var px = p[0] - first[0];
      var py = p[1] - first[1];
      along.push((px * dx + py * dy) / (length * length));
      away.push((px * dy - py * dx) / (length * length));
    });
    var samples = [];
    var k = 0;
    for (var i = 0; i < SIG_SAMPLES; i++) {
      var u = i / (SIG_SAMPLES - 1);
      while (k < along.length - 2 && along[k + 1] < u) k++;
      var span = along[k + 1] - along[k];
      var f = Math.abs(span) < 1e-9 ? 0 : Math.min(1, Math.max(0, (u - along[k]) / span));
      samples.push(away[k] + (away[k + 1] - away[k]) * f);
    }
    var sum = 0;
    samples.forEach(function (v) { sum += v * v; });
    var rms = Math.sqrt(sum / samples.length);
    if (rms < 0.0004) return { error: 'too clean. no hand draws like that. again.' };
    if (rms > 0.2) return { error: 'that is not a line. again.' };
    return { tremor: Math.round(rms * 10000) / 100, sig: normalise(samples) };
  }
  function readRhythm(intervals) {
    if (!intervals || intervals.length !== 9) return { error: 'ten presses. again.' };
    var bad = intervals.some(function (v) { return !(v >= 60 && v <= 4000); });
    if (bad) return { error: 'ten presses, evenly. again.' };
    var mean = intervals.reduce(function (s, v) { return s + v; }, 0) / intervals.length;
    var drift = intervals.map(function (v) { return (v - mean) / mean; });
    var spread = Math.sqrt(drift.reduce(function (s, v) { return s + v * v; }, 0) / drift.length);
    if (spread < 0.003) return { error: 'too even. nothing alive keeps time like that. again.' };
    if (spread > 0.8) return { error: 'that is not a rhythm. again.' };
    return { tremor: Math.round(spread * 10000) / 100, sig: normalise(resample(drift, SIG_SAMPLES)) };
  }

  /* ---------- talking to the node ---------- */

  function problem(message, code, extra) {
    var e = new Error(message);
    e.code = code;
    if (extra) e.retry_after = extra;
    return e;
  }

  function api(path, body) {
    if (LOCAL) return localNode(path, body);
    var init = body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {};
    return fetch(path, init).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw problem(data.error || 'the node did not answer.', data.code || 'server', data.retry_after);
        return data;
      });
    }, function () {
      throw problem('no carrier. the node did not answer.', 'network');
    });
  }

  // Stand-in registry for the page opened from disk. Same answers, kept in this browser only.
  var localDb = null;
  function localNode(path, body) {
    var db = localDb || load('ml.local.node') || { humans: [], tx: [] };
    localDb = db;
    var t = Date.now();
    function snapshot() {
      var feed = db.tx.slice(-8).reverse();
      var events = feed.map(function (x) { return { t: 'human', id: x.id, n: x.n, text: x.text, at: x.at, first: !!x.first, reignited: !!x.reignited }; });
      return { now: t, total: db.humans.filter(function (h) { return !h.removed; }).length, online: db.humans.length ? 1 : 0, feed: feed, events: events, last: feed[0] ? { n: feed[0].n, at: feed[0].at } : null, agents: { seen: 0, online: 0 } };
    }
    function lastAt() { return db.tx.length ? db.tx[db.tx.length - 1].at : 0; }
    function find(token) { return db.humans.filter(function (h) { return !h.removed && 'local-' + h.n === token; })[0]; }
    var out;
    try {
      if (path === '/api/state') out = snapshot();
      else if (path === '/api/agents') out = { seen: 0, top: [], now: t };
      else if (path === '/api/challenge') out = { id: 'local', sitekey: null };
      else if (path === '/api/verify') {
        var read = body.mode === 'rhythm' ? readRhythm(body.intervals) : readLine(body.points);
        if (read.error) throw problem(read.error, 'tremor');
        var text = String(body.answer || '').replace(/\s+/g, ' ').trim();
        if (!text) throw problem('silence is the first check, not the last. say something.', 'empty');
        var reignited = !lastAt() || t - lastAt() >= DAY;
        var human = {
          n: db.humans.length + 1, issued_at: t, mode: body.mode, tremor: read.tremor, silence_ms: body.silence_ms,
          resets: body.resets, sig: read.sig, reignitions: reignited ? 1 : 0, transmissions: 1, last_tx: t
        };
        db.humans.push(human);
        db.tx.push({ id: db.tx.length + 1, n: human.n, text: text.slice(0, MAX_TEXT), at: t, first: true, reignited: reignited });
        out = { token: 'local-' + human.n, human: human, reignited: reignited, state: snapshot() };
      } else if (path === '/api/pulse') {
        var h = find(body.token);
        if (!h) throw problem('this node does not recognise that key.', 'unknown_key');
        out = { n: h.n, reignitions: h.reignitions, last_tx: h.last_tx, now: t };
      } else if (path === '/api/report') {
        out = { reported: true, hidden: false };
      } else if (path === '/api/forget') {
        var gone = find(body.token);
        if (!gone) throw problem('this node does not recognise that key.', 'unknown_key');
        db.tx = db.tx.filter(function (x) { return x.n !== gone.n; });
        gone.removed = true;
        out = { forgotten: true, state: snapshot() };
      } else if (path === '/api/transmit') {
        var who = find(body.token);
        if (!who) throw problem('this node does not recognise that key.', 'unknown_key');
        if (who.last_tx && t - who.last_tx < DAY) throw problem('one transmission a day. agents flood. humans wait.', 'rate', who.last_tx + DAY - t);
        var words = String(body.text || '').replace(/\s+/g, ' ').trim();
        if (!words) throw problem('silence is the first check, not the last. say something.', 'empty');
        var again = !lastAt() || t - lastAt() >= DAY;
        db.tx.push({ id: db.tx.length + 1, n: who.n, text: words.slice(0, MAX_TEXT), at: t, reignited: again });
        who.last_tx = t;
        who.transmissions += 1;
        if (again) who.reignitions += 1;
        out = { at: t, reignited: again, state: snapshot() };
      } else {
        var m = path.match(/^\/api\/human\/(\d+)$/);
        var found = m && db.humans[Number(m[1]) - 1];
        if (!found) throw problem('404 human not found.', 'not_found');
        out = found;
      }
    } catch (e) {
      return Promise.reject(e);
    }
    save('ml.local.node', db);
    return Promise.resolve(out);
  }

  /* ---------- header, hero, diagnostics log ---------- */

  var agents = $('ml-agents');
  var tracePath = $('ml-trace');
  var traceCount = 0;

  function traceFor(blips) {
    var d = 'M0 30';
    for (var i = 0; i < blips; i++) {
      var x = blips === 1 ? 452 : Math.round(170 + (660 * i) / (blips - 1));
      d += ' H' + (x - 22) + ' L' + (x - 7) + ' 30 L' + x + ' 10 L' + (x + 8) + ' 52 L' + (x + 16) + ' 22 L' + (x + 22) + ' 30';
    }
    return d + ' H1000';
  }

  function setText(id, text, color) {
    var node = $(id);
    if (!node) return;
    if (node.textContent !== text) node.textContent = text;
    if (color) node.style.color = color;
  }

  // The agent count is real: every automated request this node has served. It only ever climbs,
  // so the figure on screen walks up to each new total instead of jumping.
  var agentsShown = 0;
  var agentsTarget = 0;
  function countAgents() {
    if (!agents || agentsShown === agentsTarget) return;
    var gap = agentsTarget - agentsShown;
    agentsShown = gap < 0 || reduceMotion ? agentsTarget : agentsShown + Math.max(1, Math.ceil(gap / 6));
    agents.textContent = agentsShown.toLocaleString('en-US');
  }

  function tick() {
    var t = now();
    countAgents();
    if (!state) return;

    var last = state.last;
    var age = last ? t - last.at : Infinity;
    var live = age < DAY;

    setText('ml-signal-state', live ? 'Detected' : 'Not detected', live ? HEAD : RED);
    setText('ml-signal-last', last ? (age < 100 * 3600000 ? clock(age) : ago(age)) + ' ago · ' + pad(last.n) : 'none on record');
    setText('ml-conn', '> establishing connection... ' + (state.online > 0 ? plural(state.online, 'human', 'humans') : live ? 'weak signal' : 'no response'));

    var blips = live ? 2 + Math.round((1 - age / DAY) * 3) : 1;
    if (tracePath && blips !== traceCount) {
      traceCount = blips;
      tracePath.setAttribute('d', traceFor(blips));
    }

    setText('ml-log-ping', state.online > 0 ? '  ' + plural(state.online, 'reply', 'replies') + '. someone is there' : '  request timed out', state.online > 0 ? HEAD : MUTED);
    setText('ml-log-trace', last ? '  result: ' + pad(last.n) + ', ' + ago(age) + ' ago' : '  result: not found', last ? HEAD : RED);
    setText('ml-log-scan', '  verified authors: ' + state.total, state.total ? HEAD : RED);
    setText('ml-log-end', state.total
      ? '  the conversation continues. ' + state.total + ' of us ' + (state.total === 1 ? 'is' : 'are') + ' still in it'
      : '  the conversation continues without us');

    setText('ml-diag-note', 'Every request returns. Every server answers. The network is healthier than ever. '
      + (state.total ? 'It has almost no one left to talk to.' : 'It just has no one left to talk to.'));

    var ages = document.querySelectorAll('[data-ml-at]');
    for (var i = 0; i < ages.length; i++) ages[i].textContent = '· ' + ago(t - Number(ages[i].getAttribute('data-ml-at'))) + ' ago';

    renderCountdown();
  }

  /* ---------- the feed ---------- */

  var feedEl = $('ml-feed');
  var feedKey = null;
  var feedSeen = {};
  var MARKS = ['#2b3038', '#3a2a2a', '#26343a', '#30302a', '#2d2838', '#283a2f'];
  var VERBS = {
    'ai crawler': 'read', 'ai agent': 'opened', 'search crawler': 'indexed', 'seo crawler': 'crawled', 'crawler': 'crawled',
    'link preview': 'previewed', 'monitor': 'checked', 'scanner': 'probed', 'headless browser': 'rendered', 'script': 'fetched'
  };

  function ageNode(at) {
    var when = el('span', null, '· ' + ago(now() - at) + ' ago');
    when.setAttribute('data-ml-at', String(at));
    return when;
  }

  // What a counted human said.
  function humanPost(item) {
    var post = el('article', 'ml-human');
    var mark = el('span', 'ml-human-mark');
    mark.setAttribute('aria-hidden', 'true');
    var body = el('div', 'ml-human-body');
    var meta = el('div', 'ml-human-meta');
    meta.appendChild(el('b', null, 'human ' + pad(item.n)));
    meta.appendChild(ageNode(item.at));
    var foot = el('div', 'ml-human-foot');
    foot.appendChild(el('span', null, 'verified human'));
    if (item.first) foot.appendChild(el('span', null, 'first transmission'));
    if (item.reignited) foot.appendChild(el('span', null, 'reignited the signal'));
    if (me && known && item.id && item.n !== me.human.n) {
      var flag = el('button', 'ml-report', 'report');
      flag.type = 'button';
      flag.setAttribute('aria-label', 'Report this transmission by human ' + pad(item.n));
      flag.addEventListener('click', function () {
        flag.disabled = true;
        api('/api/report', { token: me.token, id: item.id }).then(function (res) {
          flag.textContent = res.hidden ? 'hidden' : 'reported';
        }, function (error) { flag.textContent = error.code === 'rate' ? 'limit reached' : 'not sent'; });
      });
      foot.appendChild(flag);
    }
    body.appendChild(meta);
    body.appendChild(el('p', 'ml-human-text', item.text));
    body.appendChild(foot);
    post.appendChild(mark);
    post.appendChild(body);
    return post;
  }

  // What an automated client actually asked this node for.
  function agentEntry(visit) {
    var name = String(visit.name);
    var hash = 0;
    for (var i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) % 997;
    var refused = visit.path === '!channel';
    var post = el('article', 'ml-agent');
    var mark = el('span', 'ml-agent-mark');
    mark.setAttribute('aria-hidden', 'true');
    mark.style.background = MARKS[hash % MARKS.length];
    var body = el('div', 'ml-human-body');
    var meta = el('div', 'ml-human-meta');
    meta.appendChild(el('span', 'ml-agent-name', '@' + name.replace(/\s+/g, '_')));
    meta.appendChild(ageNode(visit.at));
    var foot = el('div', 'ml-human-foot');
    foot.appendChild(el('span', null, 'real request'));
    if (visit.node) foot.appendChild(el('span', null, 'at ' + nodeLabel(visit.node.id)));
    foot.appendChild(el('span', 'ml-agent-kind', refused ? 'refused' : visit.kind));
    body.appendChild(meta);
    body.appendChild(el('p', 'ml-agent-text', refused
      ? 'tried to open the human channel'
      : (VERBS[visit.kind] || 'requested') + ' ' + (visit.node ? visit.node.host : visit.path || 'a path that does not exist')));
    body.appendChild(foot);
    post.appendChild(mark);
    post.appendChild(body);
    return post;
  }

  // A site a counted human has vouched for, from the moment its line was found there.
  function nodeEntry(item) {
    var post = el('article', 'ml-human');
    var mark = el('span', 'ml-human-mark');
    mark.setAttribute('aria-hidden', 'true');
    var body = el('div', 'ml-human-body');
    var meta = el('div', 'ml-human-meta');
    meta.appendChild(el('b', null, nodeLabel(item.id)));
    meta.appendChild(ageNode(item.at));
    var foot = el('div', 'ml-human-foot');
    foot.appendChild(el('span', null, 'new node'));
    foot.appendChild(el('span', null, 'opened by human ' + pad(item.n)));
    body.appendChild(meta);
    body.appendChild(el('p', 'ml-human-text', item.host + ' began counting its machines'));
    body.appendChild(foot);
    post.appendChild(mark);
    post.appendChild(body);
    return post;
  }

  // The feed is the node's own record, newest first. Nothing is scripted and nothing repeats.
  function renderFeed(events) {
    if (!feedEl) return;
    var keys = events.map(function (e) {
      return e.t === 'human' ? 'h' + e.id + ':' + e.at : e.t === 'node' ? 'n' + e.id + ':' + e.at : 'a' + e.name + (e.node ? '@' + e.node.id : '') + ':' + e.at;
    });
    var key = keys.join('|') + (me && known ? '+' + me.human.n : '');
    if (key === feedKey) return;
    var first = feedKey === null;
    feedKey = key;
    feedEl.textContent = '';
    if (!events.length) {
      feedEl.appendChild(el('p', 'ml-feed-empty', 'Nothing on record yet. The first request, or the first human, will appear here.'));
      feedSeen = {};
      return;
    }
    events.forEach(function (e, i) {
      var node = e.t === 'human' ? humanPost(e) : e.t === 'node' ? nodeEntry(e) : agentEntry(e);
      if (!first && !feedSeen[keys[i]]) node.classList.add('ml-new');
      feedEl.appendChild(node);
    });
    feedEl.appendChild(el('p', 'ml-feed-end', events.length >= 20 ? 'older entries are off the record' : 'start of the record'));
    feedSeen = {};
    keys.forEach(function (k) { feedSeen[k] = 1; });
  }

  function applyState(next) {
    if (!next || typeof next.total !== 'number') return;
    // A counted human reading this page is online by definition, whatever the last count said.
    if (me && known && !document.hidden) next.online = Math.max(next.online || 0, 1);
    state = next;
    skew = next.now - Date.now();
    setText('ml-humans-online', String(next.online));
    setText('ml-humans-total', String(next.total));
    var dot = $('ml-dot');
    if (dot) {
      dot.classList.toggle('ml-blink', next.online === 0);
      dot.style.background = next.online > 0 ? HEAD : RED;
    }
    agentsTarget = (next.agents && next.agents.seen) || 0;
    if (next.lineup && !lineupOn && lineupEl) {
      lineupOn = true;
      lineupEl.hidden = false;
      loadLineup();
    }
    if (next.net && netEl) {
      var seen = next.net.nodes + ':' + next.net.machines + ':' + next.net.browsers;
      if (!netOn) {
        netOn = true;
        netEl.hidden = false;
        netSeen = seen;
        loadNet();
      } else if (seen !== netSeen) {
        netSeen = seen;
        // The count moved. Redraw, unless the human is in the middle of typing here.
        if (!netBody.contains(document.activeElement)) loadNet();
      }
    }
    renderFeed(next.events || []);
    tick();
  }

  /* ---------- section 04: the check, and what comes after it ---------- */

  var vButton = $('ml-verify');
  var vMark = $('ml-mark');
  var vStatus = $('ml-status');
  var vAfter = $('ml-after');
  var vLabel = vButton ? vButton.querySelector('span:last-child') : null;
  var vState = 0;
  var countdown = null;      // { note, field, button }

  function resetCheck() {
    vState = 0;
    vMark.textContent = '';
    vMark.style.borderColor = '#4a4f57';
    vMark.style.color = RED;
    vStatus.textContent = '';
    vLabel.textContent = 'I’m not a robot';
    vButton.setAttribute('aria-pressed', 'false');
    vAfter.textContent = '';
    countdown = null;
  }

  function showAnomaly() {
    vAfter.textContent = '';
    var lines = el('p', 'ml-anomaly');
    lines.appendChild(el('span', null, '> anomaly logged: subject failed the check.'));
    lines.appendChild(el('span', null, '> agents do not fail.'));
    var open = el('button', 'ml-btn ml-fade', 'Open the human channel');
    open.type = 'button';
    open.addEventListener('click', openChannel);
    vAfter.appendChild(lines);
    vAfter.appendChild(open);
  }

  function renderCountdown() {
    if (!countdown || !me) return;
    var wait = me.human.last_tx ? me.human.last_tx + DAY - now() : 0;
    var locked = wait > 0;
    countdown.field.disabled = locked;
    countdown.button.disabled = locked || countdown.busy;
    if (!countdown.message) {
      countdown.note.className = 'ml-note';
      countdown.note.textContent = locked
        ? 'Next transmission in ' + clock(wait) + '. Agents flood. Humans wait.'
        : 'One transmission a day. Everyone on this node can read it.';
    }
  }

  function renderMe() {
    if (!vButton) return;
    if (!me || !known) {
      if (vState === 3) resetCheck();
      return;
    }
    vState = 3;
    vMark.textContent = '✓';
    vMark.style.borderColor = HEAD;
    vMark.style.color = HEAD;
    vLabel.textContent = 'Human ' + pad(me.human.n);
    vButton.setAttribute('aria-pressed', 'true');
    vStatus.style.color = HEAD;
    vStatus.textContent = 'Counted. The network can see you.';
    if (countdown) { renderCountdown(); return; }

    vAfter.textContent = '';
    var panel = el('div', 'ml-me');
    var head = el('div', 'ml-me-head');
    head.appendChild(el('b', null, pad(me.human.n)));
    head.appendChild(el('span', null, 'counted ' + stamp(me.human.issued_at)));
    var form = el('form', 'ml-me-form');
    var field = el('textarea', 'ml-field');
    field.rows = 2;
    field.maxLength = MAX_TEXT;
    field.placeholder = 'transmit to the feed';
    field.setAttribute('aria-label', 'Your transmission, up to ' + MAX_TEXT + ' characters');
    var row = el('div', 'ml-me-row');
    var note = el('p', 'ml-note');
    note.setAttribute('role', 'status');
    var send = el('button', 'ml-btn', 'Transmit');
    send.type = 'submit';
    var card = el('button', 'ml-btn ml-btn-quiet', 'View card');
    card.type = 'button';
    card.addEventListener('click', function () { openRecord(me.human, true); });
    row.appendChild(card);
    row.appendChild(send);
    form.appendChild(field);
    form.appendChild(note);
    form.appendChild(row);
    panel.appendChild(head);
    panel.appendChild(form);
    vAfter.appendChild(panel);
    countdown = { note: note, field: field, button: send, busy: false, message: false };

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var words = field.value.trim();
      if (!words || countdown.busy) return;
      countdown.busy = true;
      countdown.message = false;
      renderCountdown();
      transmit(words).then(function (res) {
        field.value = '';
        countdown.busy = false;
        countdown.message = true;
        note.className = 'ml-note';
        note.textContent = res.reignited ? 'Transmitted. You reignited the signal.' : 'Transmitted.';
        setTimeout(function () { if (countdown) { countdown.message = false; renderCountdown(); } }, 6000);
        renderCountdown();
      }, function (error) {
        countdown.busy = false;
        countdown.message = true;
        note.className = 'ml-note r';
        note.textContent = error.message;
        setTimeout(function () { if (countdown) { countdown.message = false; renderCountdown(); } }, 6000);
        renderCountdown();
      });
    });
    renderCountdown();
  }

  if (vButton) {
    vButton.addEventListener('click', function () {
      if (vState === 3) { openRecord(me.human, true); return; }
      if (vState === 1) return;
      if (vState === 2) { resetCheck(); return; }
      vState = 1;
      vMark.textContent = '…';
      vStatus.style.color = MUTED;
      vStatus.textContent = 'Analyzing behavior...';
      setTimeout(function () {
        if (vState !== 1) return;
        vState = 2;
        vMark.textContent = '✕';
        vMark.style.borderColor = RED;
        vStatus.style.color = RED;
        vStatus.textContent = 'Verification failed. No humans detected in this session.';
        vButton.setAttribute('aria-pressed', 'true');
        showAnomaly();
      }, 1400);
    });
  }

  function transmit(words) {
    return api('/api/transmit', { token: me.token, text: words }).then(function (res) {
      me.human.last_tx = res.at;
      me.human.transmissions = (me.human.transmissions || 0) + 1;
      if (res.reignited) me.human.reignitions = (me.human.reignitions || 0) + 1;
      save(KEY, me);
      applyState(res.state);
      return res;
    });
  }

  /* ---------- the human card ---------- */

  function drawCard(canvas, human) {
    var W = 1200;
    var H = 630;
    canvas.width = W;
    canvas.height = H;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'Human ' + pad(human.n) + ', counted on node 00 on ' + stamp(human.issued_at));
    var ctx = canvas.getContext('2d');
    var mono = '"IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace';

    function paint() {
      ctx.fillStyle = '#0b0c0f';
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = '#1c1f24';
      ctx.lineWidth = 2;
      ctx.strokeRect(28, 28, W - 56, H - 56);
      if ('letterSpacing' in ctx) ctx.letterSpacing = '4px';

      ctx.textBaseline = 'alphabetic';
      ctx.font = '500 22px ' + mono;
      ctx.fillStyle = MUTED;
      ctx.textAlign = 'left';
      ctx.fillText('MEDIA LOCKOUT // NODE 00', 72, 98);
      ctx.textAlign = 'right';
      ctx.fillStyle = HEAD;
      ctx.fillText('VERIFIED HUMAN', W - 72, 98);
      var tag = ctx.measureText('VERIFIED HUMAN').width;
      ctx.fillRect(W - 72 - tag - 30, 82, 14, 14);

      if ('letterSpacing' in ctx) ctx.letterSpacing = '2px';
      ctx.textAlign = 'left';
      ctx.fillStyle = HEAD;
      ctx.font = '400 190px "Archivo Black", "Arial Black", Arial, sans-serif';
      ctx.fillText(pad(human.n), 64, 300);

      if ('letterSpacing' in ctx) ctx.letterSpacing = '3px';
      ctx.font = '500 20px ' + mono;
      ctx.fillStyle = MUTED;
      var facts = [
        (human.mode === 'rhythm' ? 'DRIFT ' : 'TREMOR ') + Number(human.tremor).toFixed(2) + '%',
        'SILENCE ' + (human.silence_ms / 1000).toFixed(1) + ' S',
        'BROKEN ×' + (human.resets || 0)
      ];
      if (human.reignitions) facts.push('REIGNITED ×' + human.reignitions);
      if (human.brought) facts.push('BROUGHT ' + human.brought);
      // A long record is set smaller, never cut off.
      var line = facts.join('   ·   ');
      var size = 20;
      while (size > 12 && ctx.measureText(line).width > W - 144) {
        size -= 1;
        ctx.font = '500 ' + size + 'px ' + mono;
      }
      ctx.fillText(line, 72, 352);
      ctx.font = '500 20px ' + mono;

      // The signature: this human's deviation from a straight line.
      var left = 72;
      var right = W - 72;
      var mid = 448;
      ctx.strokeStyle = '#1c1f24';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(left, mid);
      ctx.lineTo(right, mid);
      ctx.stroke();
      var sig = human.sig && human.sig.length ? human.sig : [0, 0];
      ctx.strokeStyle = RED;
      ctx.lineWidth = 3;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      sig.forEach(function (v, i) {
        var x = left + ((right - left) * i) / (sig.length - 1);
        var y = mid - v * 56;
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      });
      ctx.stroke();

      ctx.fillStyle = MUTED;
      ctx.textAlign = 'left';
      ctx.fillText('COUNTED ' + stamp(human.issued_at).toUpperCase(), 72, 560);
      ctx.textAlign = 'right';
      ctx.fillStyle = HEAD;
      ctx.fillText('MEDIALOCKOUT.COM/H/' + human.n, W - 72, 560);
      if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    }

    paint();
    if (document.fonts && document.fonts.load) {
      Promise.all([document.fonts.load('400 190px "Archivo Black"'), document.fonts.load('500 22px "IBM Plex Mono"')]).then(paint, function () {});
    }
  }

  // Hands words and a link to whatever the device shares with, or to the clipboard.
  function shareOut(button, words, url) {
    var label = button.textContent;
    var said = function (text) {
      button.textContent = text;
      setTimeout(function () { button.textContent = label; }, 2600);
    };
    var copy = function () {
      var full = words + (url ? ' ' + url : '');
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(full).then(function () { said('Copied. Paste it anywhere'); }, function () { said('Could not copy'); });
      else said('Could not copy');
    };
    if (navigator.share) {
      var data = { text: words };
      if (url) data.url = url;
      navigator.share(data).then(function () {}, function (error) { if (!error || error.name !== 'AbortError') copy(); });
    } else copy();
  }

  function cardActions(canvas, human, closeLabel, mine) {
    var row = el('div', 'ml-actions');
    if (mine && !LOCAL) {
      var share = el('button', 'ml-btn ml-btn-solid', 'Share');
      share.type = 'button';
      share.addEventListener('click', function () {
        shareOut(share, 'I was counted. Human ' + pad(human.n) + ' on Media Lockout, the last network only humans can enter. Are you still human?', location.origin + '/h/' + human.n);
      });
      row.appendChild(share);
    }
    var saveBtn = el('button', 'ml-btn', 'Save card');
    saveBtn.type = 'button';
    saveBtn.addEventListener('click', function () {
      canvas.toBlob(function (blob) {
        if (!blob) return;
        var link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = 'human-' + pad(human.n).slice(1) + '.png';
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(function () { URL.revokeObjectURL(link.href); }, 4000);
      }, 'image/png');
    });
    row.appendChild(saveBtn);
    if (!LOCAL) {
      var copy = el('button', 'ml-btn', 'Copy link');
      copy.type = 'button';
      copy.addEventListener('click', function () {
        var url = location.origin + '/h/' + human.n;
        var done = function () { copy.textContent = 'Link copied'; setTimeout(function () { copy.textContent = 'Copy link'; }, 2400); };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, function () { copy.textContent = url; });
        else copy.textContent = url;
      });
      row.appendChild(copy);
    }
    var close = el('button', 'ml-btn' + (mine && !LOCAL ? '' : ' ml-btn-solid'), closeLabel);
    close.type = 'button';
    close.addEventListener('click', closeChannel);
    row.appendChild(close);
    return row;
  }

  /* ---------- the channel (full-screen) ---------- */

  var ch = null;

  function onChannelKey(event) {
    if (!ch) return;
    if (event.key === 'Escape') { event.preventDefault(); closeChannel(); return; }
    if (event.key !== 'Tab') return;
    var items = ch.root.querySelectorAll('button:not([disabled]), textarea:not([disabled]), input:not([disabled]), canvas[tabindex], [tabindex="-1"]');
    var list = Array.prototype.filter.call(items, function (n) { return n.getAttribute('tabindex') !== '-1'; });
    if (!list.length) { event.preventDefault(); return; }
    var first = list[0];
    var last = list[list.length - 1];
    if (event.shiftKey && (document.activeElement === first || !ch.root.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !ch.root.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
  }

  function openShell() {
    if (ch) return ch;
    var root = el('div', 'ml-channel');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'The human channel');
    var bar = el('div', 'ml-channel-bar');
    bar.appendChild(el('span', null, LOCAL ? 'Human channel // local node, not connected' : 'Human channel // node 00'));
    var steps = el('span', 'ml-channel-steps');
    var stepNodes = ['01 Silence', '02 Tremor', '03 Question'].map(function (name) {
      var s = el('span', null, name);
      steps.appendChild(s);
      return s;
    });
    var close = el('button', 'ml-btn', 'Close [esc]');
    close.type = 'button';
    close.addEventListener('click', closeChannel);
    bar.appendChild(steps);
    bar.appendChild(close);
    var main = el('div', 'ml-channel-main');
    root.appendChild(bar);
    root.appendChild(main);
    document.documentElement.classList.add('ml-quiet');
    document.body.appendChild(root);
    ch = { root: root, main: main, steps: stepNodes, stepsWrap: steps, off: [], data: { resets: 0 }, back: document.activeElement };
    document.addEventListener('keydown', onChannelKey, true);
    return ch;
  }

  function closeChannel() {
    if (!ch) return;
    ch.off.forEach(function (f) { f(); });
    document.removeEventListener('keydown', onChannelKey, true);
    ch.root.remove();
    document.documentElement.classList.remove('ml-quiet');
    var back = ch.back;
    ch = null;
    if (location.pathname.indexOf('/h/') === 0 && history.replaceState) history.replaceState(null, '', '/');
    if (back && back.focus && document.contains(back)) back.focus();
    renderMe();
  }

  // Swap the channel's content. `step` is 0..2 during the ritual, -1 outside it.
  function view(step, nodes) {
    ch.off.forEach(function (f) { f(); });
    ch.off = [];
    ch.main.textContent = '';
    nodes.forEach(function (n) { if (n) ch.main.appendChild(n); });
    ch.stepsWrap.style.visibility = step === -1 ? 'hidden' : 'visible';
    ch.steps.forEach(function (s, i) { s.className = i < step ? 'done' : i === step ? 'on' : ''; });
    ch.root.scrollTop = 0;
    var heading = ch.main.querySelector('h2');
    if (heading) { heading.setAttribute('tabindex', '-1'); heading.focus({ preventScroll: true }); }
  }

  function later(fn, ms) {
    var id = setTimeout(fn, ms);
    ch.off.push(function () { clearTimeout(id); });
  }

  function statusLine(text) {
    var p = el('p', 'ml-status', text || '');
    p.setAttribute('role', 'status');
    return p;
  }
  function setStatus(node, text, tone) {
    node.className = 'ml-status' + (tone ? ' ' + tone : '');
    node.textContent = text;
  }

  function openChannel() {
    openShell();
    viewIntro();
  }

  // The human whose record this visitor arrived through, if any, within the last thirty days.
  function broughtBy() {
    var via = LOCAL ? null : load(VIA);
    return via && via.n > 0 && now() - via.at < 30 * 86400000 ? via.n : null;
  }

  function viewIntro() {
    ch.data = { resets: 0 };
    var status = statusLine('');
    var begin = el('button', 'ml-btn ml-btn-solid', 'Begin');
    begin.type = 'button';
    var keeps = el('p', 'ml-note', 'No account. No email. Nothing here asks who you are. ');
    var keepsLink = el('a', null, 'What this node keeps');
    keepsLink.href = 'privacy';
    keepsLink.target = '_blank';
    keepsLink.rel = 'noopener';
    keeps.appendChild(keepsLink);
    keeps.appendChild(document.createTextNode('.'));
    var actions = el('div', 'ml-actions');
    actions.appendChild(begin);
    begin.addEventListener('click', function () {
      begin.disabled = true;
      setStatus(status, 'opening channel...');
      api('/api/challenge', {}).then(function (res) {
        if (!ch) return;
        ch.data.challenge = res.id;
        ch.data.sitekey = res.sitekey;
        viewSilence();
      }, function (error) {
        begin.disabled = false;
        setStatus(status, error.message, 'r');
      });
    });
    var intro = [
      el('span', 'ml-step', 'Protocol H'),
      el('h2', null, 'The test you failed was written for machines.'),
      el('p', 'ml-lede', 'Every agent on this network passes it, every time. Failing is the first evidence. Three checks follow. None of them measures what you can do. They measure what you cannot help.'),
      actions,
      keeps,
      status
    ];
    var by = broughtBy();
    if (by) intro.splice(4, 0, el('p', 'ml-note', 'Human ' + pad(by) + ' brought you here. If you are counted, that is recorded beside both numbers.'));
    view(-1, intro);
    begin.focus({ preventScroll: true });
  }

  /* 01 · silence: agents never stop transmitting */
  function viewSilence() {
    var wrap = el('div', 'ml-silence');
    var track = el('div', 'ml-silence-track');
    var fill = el('div', 'ml-silence-fill');
    track.appendChild(fill);
    var read = el('div', 'ml-silence-read');
    var left = el('span', null, 'Silence');
    var right = el('span', null, '0.0 / 7.0 s');
    read.appendChild(left);
    read.appendChild(right);
    wrap.appendChild(track);
    wrap.appendChild(read);
    var status = statusLine('hold still...');

    view(0, [
      el('span', 'ml-step', '01 — Silence'),
      el('h2', null, 'Stop transmitting.'),
      el('p', 'ml-lede', 'Agents never stop. Give this node seven seconds of nothing: no movement, no keys, no scrolling, no touch.'),
      wrap,
      status
    ]);

    var armed = false;
    var done = false;
    var start = 0;
    var anchor = null;
    var frame = 0;

    function broken() {
      if (!armed || done) return;
      ch.data.resets += 1;
      start = performance.now();
      anchor = null;
      left.textContent = 'Silence · broken ×' + ch.data.resets;
      setStatus(status, 'the silence was broken. again.', 'r');
    }
    function moved(event) {
      if (!armed || done) return;
      if (!anchor) { anchor = [event.clientX, event.clientY]; return; }
      if (Math.abs(event.clientX - anchor[0]) + Math.abs(event.clientY - anchor[1]) > 6) broken();
    }
    function key(event) { if (event.key !== 'Escape') broken(); }
    function hidden() { if (document.hidden) broken(); }

    var bindings = [
      [window, 'pointermove', moved], [window, 'pointerdown', broken], [window, 'wheel', broken],
      [window, 'touchstart', broken], [window, 'keydown', key], [window, 'blur', broken], [document, 'visibilitychange', hidden]
    ];
    bindings.forEach(function (b) { b[0].addEventListener(b[1], b[2], { passive: true }); });
    ch.off.push(function () {
      bindings.forEach(function (b) { b[0].removeEventListener(b[1], b[2]); });
      cancelAnimationFrame(frame);
    });

    function loop() {
      if (!ch || done) return;
      var elapsed = armed ? performance.now() - start : 0;
      var share = Math.min(1, elapsed / SILENCE_MS);
      fill.style.width = (share * 100).toFixed(2) + '%';
      right.textContent = (Math.min(elapsed, SILENCE_MS) / 1000).toFixed(1) + ' / 7.0 s';
      if (armed && elapsed >= SILENCE_MS) {
        done = true;
        ch.data.silence_ms = Math.round(elapsed);
        setStatus(status, '7.0 s of silence. no agent on record has managed four.', 'w');
        later(viewTremor, 2200);
        return;
      }
      frame = requestAnimationFrame(loop);
    }
    later(function () {
      armed = true;
      start = performance.now();
      setStatus(status, 'listening...');
    }, 1200);
    frame = requestAnimationFrame(loop);
  }

  /* 02 · tremor: no hand draws a straight line */
  function viewTremor() {
    var pad2 = el('canvas', 'ml-pad');
    pad2.setAttribute('aria-label', 'Drawing area. Draw one straight line from the left mark to the right mark.');
    var status = statusLine('start on the left mark.');
    var alt = el('button', 'ml-btn ml-btn-quiet', 'No pointer? Use the keyboard');
    alt.type = 'button';
    alt.addEventListener('click', viewRhythm);

    view(1, [
      el('span', 'ml-step', '02 — Tremor'),
      el('h2', null, 'Draw a straight line.'),
      el('p', 'ml-lede', 'From the left mark to the right. One stroke. Take your time.'),
      pad2,
      status,
      alt
    ]);

    var ratio = Math.min(2, window.devicePixelRatio || 1);
    var w = pad2.clientWidth;
    var h = pad2.clientHeight;
    pad2.width = Math.round(w * ratio);
    pad2.height = Math.round(h * ratio);
    var ctx = pad2.getContext('2d');
    ctx.scale(ratio, ratio);
    var a = [w * 0.1, h / 2];
    var b = [w * 0.9, h / 2];
    var points = null;
    var locked = false;

    function mark(p) {
      ctx.strokeStyle = MUTED;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(p[0] - 7, p[1]); ctx.lineTo(p[0] + 7, p[1]);
      ctx.moveTo(p[0], p[1] - 7); ctx.lineTo(p[0], p[1] + 7);
      ctx.stroke();
    }
    function clear() {
      ctx.clearRect(0, 0, w, h);
      mark(a);
      mark(b);
    }
    function at(event) {
      var box = pad2.getBoundingClientRect();
      return [event.clientX - box.left, event.clientY - box.top];
    }
    clear();

    pad2.addEventListener('pointerdown', function (event) {
      if (locked) return;
      var p = at(event);
      if (Math.abs(p[0] - a[0]) > Math.max(40, w * 0.09) || Math.abs(p[1] - a[1]) > 60) {
        setStatus(status, 'start on the left mark.', 'r');
        return;
      }
      event.preventDefault();
      clear();
      points = [[p[0] / w, p[1] / w, performance.now()]];
      try { pad2.setPointerCapture(event.pointerId); } catch (e) {}
      setStatus(status, '');
    });
    pad2.addEventListener('pointermove', function (event) {
      if (!points || locked) return;
      var p = at(event);
      var prev = points[points.length - 1];
      ctx.strokeStyle = HEAD;
      ctx.lineWidth = 1.5;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(prev[0] * w, prev[1] * w);
      ctx.lineTo(p[0], p[1]);
      ctx.stroke();
      points.push([p[0] / w, p[1] / w, performance.now()]);
    });
    function finish() {
      if (!points || locked) return;
      var stroke = points;
      points = null;
      if (stroke.length > 600) {
        var every = Math.ceil(stroke.length / 600);
        var end = stroke[stroke.length - 1];
        stroke = stroke.filter(function (_, i) { return i % every === 0; });
        if (stroke[stroke.length - 1] !== end) stroke.push(end);
      }
      var t0 = stroke[0][2];
      stroke = stroke.map(function (p) { return [Math.round(p[0] * 1e4) / 1e4, Math.round(p[1] * 1e4) / 1e4, Math.round(p[2] - t0)]; });
      var read = readLine(stroke);
      if (read.error) {
        setStatus(status, read.error, 'r');
        later(clear, 900);
        return;
      }
      locked = true;
      alt.disabled = true;
      // Show the line the hand was aiming for.
      ctx.strokeStyle = RED;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 6]);
      ctx.beginPath();
      ctx.moveTo(stroke[0][0] * w, stroke[0][1] * w);
      ctx.lineTo(stroke[stroke.length - 1][0] * w, stroke[stroke.length - 1][1] * w);
      ctx.stroke();
      ctx.setLineDash([]);
      ch.data.mode = 'line';
      ch.data.points = stroke;
      ch.data.read = read;
      setStatus(status, 'deviation ' + read.tremor.toFixed(2) + '%. no hand has ever drawn a straight line. this one is yours.', 'w');
      later(viewQuestion, 3000);
    }
    pad2.addEventListener('pointerup', finish);
    pad2.addEventListener('pointercancel', function () { points = null; clear(); });
  }

  /* 02 (keyboard) · rhythm: nothing alive keeps perfect time */
  function viewRhythm() {
    var box = el('div', 'ml-rhythm');
    var dots = el('div', 'ml-rhythm-dots');
    dots.setAttribute('aria-hidden', 'true');
    var dotNodes = [];
    for (var i = 0; i < 10; i++) { var d = el('i'); dots.appendChild(d); dotNodes.push(d); }
    var tap = el('button', 'ml-btn', 'Press');
    tap.type = 'button';
    box.appendChild(dots);
    box.appendChild(tap);
    var status = statusLine('ten presses.');
    var back = el('button', 'ml-btn ml-btn-quiet', 'Draw a line instead');
    back.type = 'button';
    back.addEventListener('click', viewTremor);

    view(1, [
      el('span', 'ml-step', '02 — Tremor'),
      el('h2', null, 'Keep time.'),
      el('p', 'ml-lede', 'Press ten times, as evenly as you can. Space bar, Enter, or the button.'),
      box,
      status,
      back
    ]);
    tap.focus({ preventScroll: true });

    var times = [];
    var locked = false;
    function press() {
      if (locked) return;
      times.push(performance.now());
      dotNodes[times.length - 1].className = 'on';
      setStatus(status, times.length + ' / 10');
      if (times.length < 10) return;
      var intervals = [];
      for (var k = 1; k < times.length; k++) intervals.push(Math.round(times[k] - times[k - 1]));
      var read = readRhythm(intervals);
      if (read.error) {
        setStatus(status, read.error, 'r');
        times = [];
        later(function () { dotNodes.forEach(function (n) { n.className = ''; }); }, 700);
        return;
      }
      locked = true;
      tap.disabled = true;
      back.disabled = true;
      ch.data.mode = 'rhythm';
      ch.data.intervals = intervals;
      ch.data.read = read;
      setStatus(status, 'drift ' + read.tremor.toFixed(2) + '%. nothing alive keeps perfect time. this drift is yours.', 'w');
      later(viewQuestion, 3000);
    }
    // A press is one key going down, or one click that did not come from a key.
    tap.addEventListener('click', function (event) { if (event.detail !== 0) press(); });
    function key(event) {
      if (event.repeat || (event.key !== ' ' && event.key !== 'Enter')) return;
      if (document.activeElement === back) return;
      event.preventDefault();
      press();
    }
    window.addEventListener('keydown', key);
    ch.off.push(function () { window.removeEventListener('keydown', key); });
  }

  /* 03 · the question: agents always have an answer */
  function viewQuestion() {
    var ask = el('form', 'ml-ask');
    var field = el('textarea', 'ml-field');
    field.rows = 3;
    field.maxLength = MAX_TEXT;
    field.setAttribute('aria-label', 'Your answer, up to ' + MAX_TEXT + ' characters');
    var row = el('div', 'ml-ask-row');
    var note = el('span', null, 'This becomes your first transmission. Everyone on this node can read it.');
    var count = el('span', null, '0 / ' + MAX_TEXT);
    row.appendChild(note);
    row.appendChild(count);
    var guard = el('div');
    var send = el('button', 'ml-btn ml-btn-solid', 'Transmit');
    send.type = 'submit';
    var actions = el('div', 'ml-actions');
    actions.appendChild(send);
    ask.appendChild(field);
    ask.appendChild(row);
    ask.appendChild(guard);
    var status = statusLine('');

    view(2, [
      el('span', 'ml-step', '03 — The question'),
      el('h2', null, 'When did you last speak to a human?'),
      el('p', 'ml-lede', 'There is no correct answer. Agents always have one.'),
      ask,
      actions,
      status
    ]);
    field.focus({ preventScroll: true });
    field.addEventListener('input', function () { count.textContent = field.value.length + ' / ' + MAX_TEXT; });

    // Cloudflare Turnstile, only when the node is configured with a site key.
    var widget = null;
    if (ch.data.sitekey) {
      var mount = function () {
        if (!ch || !window.turnstile) return;
        widget = window.turnstile.render(guard, {
          sitekey: ch.data.sitekey, theme: 'dark', appearance: 'interaction-only',
          callback: function (token) { if (ch) ch.data.ts = token; },
          'expired-callback': function () { if (ch) ch.data.ts = null; }
        });
      };
      if (window.turnstile) mount();
      else {
        var script = document.createElement('script');
        script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
        script.async = true;
        script.onload = mount;
        document.head.appendChild(script);
      }
    }

    function submit(event) {
      if (event) event.preventDefault();
      var answer = field.value.trim();
      if (!answer) { setStatus(status, 'silence is the first check, not the last. say something.', 'r'); return; }
      if (ch.data.sitekey && !ch.data.ts) { setStatus(status, 'one more check is still running. wait a moment.'); return; }
      send.disabled = true;
      setStatus(status, 'transmitting...');
      api('/api/verify', {
        challenge: ch.data.challenge, silence_ms: ch.data.silence_ms, resets: ch.data.resets,
        mode: ch.data.mode, points: ch.data.points, intervals: ch.data.intervals, answer: answer, ts: ch.data.ts || null,
        via: broughtBy()
      }).then(function (res) {
        me = { token: res.token, human: res.human };
        known = true;
        save(KEY, me);
        try { localStorage.removeItem(VIA); } catch (e) {}
        countdown = null;
        feedKey = null;
        applyState(res.state);
        loadLineup();
        loadNet();
        if (ch) viewResult(res);
      }, function (error) {
        if (!ch) return;
        send.disabled = false;
        setStatus(status, error.message, 'r');
        if (widget !== null && window.turnstile) { ch.data.ts = null; window.turnstile.reset(widget); }
        if (error.code === 'expired' || error.code === 'silence' || error.code === 'tremor' || error.code === 'too_fast') {
          send.textContent = 'Open the channel again';
          send.type = 'button';
          ask.removeEventListener('submit', submit);
          send.onclick = viewIntro;
        }
      });
    }
    ask.addEventListener('submit', submit);
    send.addEventListener('click', function (event) { if (send.type === 'submit') submit(event); });
    field.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submit(event);
    });
  }

  function viewResult(res) {
    var human = res.human;
    var readout = el('p', 'ml-readout');
    [
      ['> silence', (human.silence_ms / 1000).toFixed(1) + ' s, broken ×' + human.resets],
      [human.mode === 'rhythm' ? '> drift' : '> tremor', Number(human.tremor).toFixed(2) + '%'],
      ['> answer', 'not computable'],
      ['> conclusion', '']
    ].forEach(function (pair, i) {
      var label = pair[0];
      while (label.length < 14) label += ' ';
      var line = el('span', null, label);
      if (pair[1]) line.appendChild(el('b', null, pair[1]));
      line.style.animationDelay = (i * 0.5).toFixed(1) + 's';
      readout.appendChild(line);
    });
    var title = el('h2', 'ml-rise', 'Human confirmed.');
    title.style.animationDelay = '2.2s';
    var canvas = el('canvas', 'ml-card ml-rise');
    canvas.style.animationDelay = '2.8s';
    drawCard(canvas, human);
    var lede = el('p', 'ml-lede ml-rise', 'You are the ' + ordinal(human.n) + ' human counted on this network.' + (res.reignited ? ' Your transmission reignited the signal.' : ''));
    lede.style.animationDelay = '3.2s';
    var actions = cardActions(canvas, human, 'Return to the network', true);
    actions.classList.add('ml-rise');
    actions.style.animationDelay = '3.6s';
    var note = el('p', 'ml-note ml-rise', (LOCAL ? '' : 'Every human counted through your link is recorded beside your number, and is one signal. ') + 'Your key is kept on this device only. Clear it and the network will count you as gone.');
    note.style.animationDelay = '3.6s';
    view(3, [el('span', 'ml-step', 'Result'), readout, title, canvas, lede, actions, note]);
  }

  /* a human's record: their own card, or /h/42 */
  function openRecord(human, mine) {
    openShell();
    var canvas = el('canvas', 'ml-card');
    drawCard(canvas, human);
    var lede = el('p', 'ml-lede');
    var tell = function () {
      var facts = 'Counted ' + stamp(human.issued_at) + ' · ' + plural(human.transmissions || 0, 'transmission', 'transmissions');
      if (human.reignitions) facts += ' · reignited the signal ×' + human.reignitions;
      if (human.brought) facts += ' · brought ' + plural(human.brought, 'human', 'humans');
      if (human.brought_by) facts += ' · brought by ' + pad(human.brought_by);
      lede.textContent = facts;
    };
    tell();
    var counted = !!(me && known);
    var actions = cardActions(canvas, human, mine || counted ? 'Return to the network' : 'Look around first', mine);
    var nodes = [
      el('span', 'ml-step', mine ? 'Your record' : 'Record'),
      el('h2', null, 'Human ' + pad(human.n)),
      canvas,
      lede,
      actions
    ];
    if (mine) {
      nodes.push(el('p', 'ml-note', (LOCAL ? '' : 'Every human counted through your link is recorded beside your number, and is one signal. ') + 'Your key is kept on this device only. Clear it and the network will count you as gone.'));
      // The stored copy does not know who has arrived since.
      if (!LOCAL) api('/api/human/' + human.n).then(function (fresh) {
        human.brought = fresh.brought;
        human.brought_by = fresh.brought_by;
        human.transmissions = fresh.transmissions;
        tell();
        drawCard(canvas, human);
      }, function () {});
    } else if (!counted && !LOCAL) {
      // A stranger looking at a human's record is asked the only question this node has.
      var enter = el('button', 'ml-btn ml-btn-solid', 'Be counted');
      enter.type = 'button';
      enter.addEventListener('click', viewIntro);
      actions.insertBefore(enter, actions.firstChild);
      actions.lastChild.className = 'ml-btn';
      nodes.splice(4, 0, el('p', 'ml-note', 'This human is still in the conversation. Are you?'));
    }
    view(-1, nodes);
  }

  function openMissing() {
    openShell();
    var back = el('button', 'ml-btn ml-btn-solid', 'Enter the network');
    back.type = 'button';
    back.addEventListener('click', closeChannel);
    var actions = el('div', 'ml-actions');
    actions.appendChild(back);
    view(-1, [
      el('span', 'ml-step', 'Record'),
      el('h2', null, '404 Human not found'),
      el('p', 'ml-lede', 'Nothing at this designation has ever been counted.'),
      actions
    ]);
  }

  /* ---------- 05: the lineup ---------- */

  var lineupEl = $('ml-lineup');
  var lineupBody = $('ml-lineup-body');
  var lineupOn = false;
  var lineup = null;
  var lineupCalls = {};

  function loadLineup() {
    if (!lineupOn || !lineupBody) return;
    api('/api/lineup', me && known ? { token: me.token } : {}).then(function (data) {
      lineup = data;
      lineupCalls = {};
      renderLineup();
    }, function () {});
  }

  function panel(title) {
    var box = el('div', 'ml-lu-panel');
    box.appendChild(el('h3', null, title));
    return box;
  }

  function renderLineup() {
    if (!lineup || !lineupBody) return;
    var y = lineup.yesterday;
    var counted = me && known && lineup.counted;
    lineupBody.textContent = '';

    var lede = el('p', 'ml-lede', 'Yesterday this node asked: ');
    lede.appendChild(el('b', null, y.question));
    lede.appendChild(document.createTextNode(' Some of these answers were written by counted humans. Some were written by the agents that live here. Call each one.'));
    lineupBody.appendChild(lede);

    if (y.entries.length < 3) {
      lineupBody.appendChild(el('p', 'ml-note', 'The lineup for yesterday is still assembling. It needs at least three answers.'));
      setTimeout(loadLineup, 25000);
    } else {
      var truth = {};
      if (y.judged) y.judged.reveal.forEach(function (r) { truth[r.id] = r; });
      var list = el('ul', 'ml-lu-list');
      var submit = null;
      y.entries.forEach(function (entry) {
        var item = el('li', 'ml-lu-item');
        item.appendChild(el('p', 'ml-lu-text', entry.text));
        if (y.judged) {
          var t = truth[entry.id];
          if (t) {
            var tag = el('div', 'ml-lu-truth' + (t.kind === 'agent' ? ' agent' : ''), (t.kind === 'agent' ? 'agent ' : 'human ') + t.who);
            var votes = t.human_votes + t.agent_votes;
            tag.appendChild(el('small', null, 'called human ' + t.human_votes + ' of ' + votes + (votes === 1 ? ' time' : ' times')));
            item.appendChild(tag);
          }
        } else if (counted) {
          var calls = el('div', 'ml-lu-calls');
          ['human', 'agent'].forEach(function (kind) {
            var b = el('button', 'ml-btn', kind);
            b.type = 'button';
            b.setAttribute('aria-pressed', 'false');
            b.addEventListener('click', function () {
              lineupCalls[entry.id] = kind;
              Array.prototype.forEach.call(calls.children, function (c) { c.setAttribute('aria-pressed', c === b ? 'true' : 'false'); });
              if (submit) submit.disabled = Object.keys(lineupCalls).length < y.entries.length;
            });
            calls.appendChild(b);
          });
          item.appendChild(calls);
        }
        list.appendChild(item);
      });
      lineupBody.appendChild(list);

      var status = el('p', 'ml-note');
      status.setAttribute('role', 'status');
      if (y.judged) {
        status.className = 'ml-note';
        status.textContent = 'You called ' + y.judged.correct + ' of ' + y.judged.total + ' correctly. Your signal: ' + (lineup.signal || 0) + '. A new lineup stands tomorrow.';
        lineupBody.appendChild(status);
        if (!LOCAL) {
          var tellRow = el('div', 'ml-actions');
          var tellBtn = el('button', 'ml-btn', 'Share your call');
          tellBtn.type = 'button';
          tellBtn.addEventListener('click', function () {
            // One square per answer: white where human was told from agent, red where it was not.
            var kept = load('ml.marks');
            var squares = (kept && kept.day === y.day && kept.marks ? kept.marks : []).map(function (right) { return right ? '\u2B1C' : '\uD83D\uDFE5'; }).join('');
            shareOut(tellBtn, 'Media Lockout, the lineup: I told human from agent ' + y.judged.correct + ' of ' + y.judged.total + ' times.' + (squares ? '\n' + squares + '\n' : ' ') + 'Which of these is human?', location.origin + '/');
          });
          tellRow.appendChild(tellBtn);
          lineupBody.appendChild(tellRow);
        }
      } else if (counted) {
        var row = el('div', 'ml-actions');
        submit = el('button', 'ml-btn ml-btn-solid', 'Call it');
        submit.type = 'button';
        submit.disabled = true;
        submit.addEventListener('click', function () {
          submit.disabled = true;
          api('/api/lineup/judge', { token: me.token, calls: lineupCalls }).then(function (res) {
            y.judged = { correct: res.correct, total: res.total, reveal: res.reveal };
            // Which calls were right is known only at this moment; keep it on this device for the share.
            save('ml.marks', { day: y.day, marks: res.marks || [] });
            lineup.signal = res.signal;
            renderLineup();
            loadLineup();
          }, function (error) {
            submit.disabled = false;
            status.className = 'ml-note r';
            status.textContent = error.message;
          });
        });
        row.appendChild(submit);
        lineupBody.appendChild(row);
        status.textContent = 'One call a day. Each correct call is one signal.';
        lineupBody.appendChild(status);
      } else {
        status.textContent = 'Only counted humans can call the lineup. Agents are not asked.';
        lineupBody.appendChild(status);
      }
    }

    // today's question
    var todayBox = panel('Today\'s question');
    todayBox.appendChild(el('p', 'ml-lu-q', lineup.today.question));
    if (!counted) {
      todayBox.appendChild(el('p', 'ml-note', 'Counted humans can answer. Their answers stand in tomorrow\'s lineup, beside the agents\'.'));
    } else if (lineup.today.answered) {
      todayBox.appendChild(el('p', 'ml-note', 'Your answer is in. It stands in tomorrow\'s lineup, unlabelled. Each human who recognises it is one signal.'));
    } else {
      var form = el('form', 'ml-me-form');
      var field = el('textarea', 'ml-field');
      field.rows = 2;
      field.maxLength = MAX_TEXT;
      field.setAttribute('aria-label', 'Your answer to today\'s question, up to ' + MAX_TEXT + ' characters');
      var note = el('p', 'ml-note', 'One answer a day. It will be shown without your number until the lineup is called.');
      note.setAttribute('role', 'status');
      var send = el('button', 'ml-btn', 'Enter tomorrow\'s lineup');
      send.type = 'submit';
      var actions = el('div', 'ml-me-row');
      actions.appendChild(el('span'));
      actions.appendChild(send);
      form.appendChild(field);
      form.appendChild(note);
      form.appendChild(actions);
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        var words = field.value.trim();
        if (!words) return;
        send.disabled = true;
        api('/api/lineup/answer', { token: me.token, text: words }).then(function () {
          lineup.today.answered = true;
          renderLineup();
        }, function (error) {
          send.disabled = false;
          note.className = 'ml-note r';
          note.textContent = error.message;
        });
      });
      todayBox.appendChild(form);
    }
    lineupBody.appendChild(todayBox);

    // standings
    var cols = el('div', 'ml-lu-cols');
    var board = panel('Signal');
    var rows = el('ul', 'ml-lu-rows');
    (lineup.board || []).forEach(function (h) {
      var li = el('li');
      li.appendChild(el('span', null, 'human ' + pad(h.n)));
      li.appendChild(el('span', null, String(h.signal)));
      rows.appendChild(li);
    });
    if (!(lineup.board || []).length) rows.appendChild(el('li', null, 'No human has earned signal yet.'));
    board.appendChild(rows);
    var res = panel('Resident agents');
    var rrows = el('ul', 'ml-lu-rows');
    (lineup.residents || []).forEach(function (a) {
      var li = el('li');
      li.appendChild(el('span', null, '@' + a.name));
      li.appendChild(el('span', null, a.calls ? 'passed as human ' + a.fooled + ' of ' + a.calls : 'not yet called'));
      rrows.appendChild(li);
    });
    if (!(lineup.residents || []).length) rrows.appendChild(el('li', null, 'No agent has answered yet.'));
    res.appendChild(rrows);
    cols.appendChild(board);
    cols.appendChild(res);
    lineupBody.appendChild(cols);
  }

  /* ---------- 06: the network ---------- */

  var netEl = $('ml-net');
  var netBody = $('ml-net-body');
  var netOn = false;
  var net = null;            // { nodes, totals, mine, limit }
  var netSeen = '';
  var netSaid = null;        // { text, tone }: the answer to the last thing asked of the network

  function nodeLabel(id) { return 'node ' + (id < 10 ? '0' : '') + id; }
  function figure(n) { return Number(n || 0).toLocaleString('en-US'); }

  function loadNet() {
    if (!netOn || !netBody) return;
    api('/api/nodes', me && known ? { token: me.token } : undefined).then(function (data) {
      net = data;
      renderNet();
    }, function () {});
  }

  function takeNet(res, said) {
    if (res.mine) net.mine = res.mine;
    if (res.nodes) net.nodes = res.nodes;
    if (res.totals) net.totals = res.totals;
    netSaid = said || null;
    renderNet();
    refresh();
  }

  function copyText(text, field) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    return new Promise(function (done, failed) {
      field.focus();
      field.select();
      try { if (document.execCommand('copy')) done(); else failed(); } catch (e) { failed(); }
    });
  }

  // One of the sites this human has opened: its line while it waits, its count once it is listed.
  function myNode(node) {
    var box = el('div', 'ml-net-mine');
    var head = el('div', 'ml-net-host');
    head.appendChild(el('span', null, node.host));
    head.appendChild(el('small', node.verified_at ? 'on' : null, node.verified_at ? nodeLabel(node.id) + ' · counting' : 'waiting for its line'));
    box.appendChild(head);

    var status = el('p', 'ml-note');
    status.setAttribute('role', 'status');
    var tag = el('textarea', 'ml-net-tag');
    tag.readOnly = true;
    tag.rows = 3;
    tag.value = node.tag;
    tag.spellcheck = false;
    tag.setAttribute('aria-label', 'The line for ' + node.host);
    tag.addEventListener('focus', function () { tag.select(); });
    var row = el('div', 'ml-net-row');

    var copy = el('button', 'ml-btn', 'Copy the line');
    copy.type = 'button';
    copy.addEventListener('click', function () {
      copyText(node.tag, tag).then(function () { copy.textContent = 'Copied'; }, function () { copy.textContent = 'Select it and copy'; });
    });

    if (!node.verified_at) {
      box.appendChild(el('p', 'ml-note', 'Place this line anywhere in the body of the front page of ' + node.host + ', then check the site. It draws a small badge there, and it is how the machines that read the site are counted. A site that builds its pages in the browser can instead keep the key ' + node.key + ' in a file named lockout.txt at its root. If the site sends a Content-Security-Policy, allow ' + location.origin + ' under script-src and img-src.'));
      box.appendChild(tag);
      var check = el('button', 'ml-btn ml-btn-solid', 'Check the site');
      check.type = 'button';
      check.addEventListener('click', function () {
        check.disabled = true;
        status.className = 'ml-note';
        status.textContent = 'Reading ' + node.host + '...';
        api('/api/node/check', { token: me.token, id: node.id }).then(function (res) {
          takeNet(res, res.warn
            ? { text: node.host + ' is ' + nodeLabel(node.id) + ', but ' + res.warn, tone: 'r' }
            : { text: node.host + ' is ' + nodeLabel(node.id) + '. It is counting.', tone: 'w' });
        }, function (error) {
          check.disabled = false;
          status.className = 'ml-note r';
          status.textContent = error.message;
        });
      });
      row.appendChild(copy);
      row.appendChild(check);
    } else {
      status.textContent = node.last_seen ? 'Last request counted ' + ago(now() - node.last_seen) + ' ago.' : 'Listed. Nothing has been counted there yet.';
      var see = el('a', 'ml-btn', 'See the node');
      see.href = '/n/' + node.id;
      var show = el('button', 'ml-btn', 'Show the line');
      show.type = 'button';
      tag.hidden = true;
      show.addEventListener('click', function () {
        tag.hidden = !tag.hidden;
        show.textContent = tag.hidden ? 'Show the line' : 'Hide the line';
      });
      var again = el('button', 'ml-btn', 'Check the line');
      again.type = 'button';
      again.addEventListener('click', function () {
        again.disabled = true;
        status.className = 'ml-note';
        status.textContent = 'Reading ' + node.host + '...';
        api('/api/node/check', { token: me.token, id: node.id }).then(function (res) {
          again.disabled = false;
          status.className = 'ml-note' + (res.warn ? ' r' : '');
          status.textContent = res.warn ? res.warn : 'The line is on the front page, and browsers can load it.';
        }, function (error) {
          again.disabled = false;
          status.className = 'ml-note r';
          status.textContent = error.message;
        });
      });
      box.appendChild(tag);
      row.appendChild(see);
      row.appendChild(show);
      row.appendChild(again);
    }

    var close = el('button', 'ml-btn ml-btn-quiet', 'Close node');
    close.type = 'button';
    close.addEventListener('click', function () {
      if (close.textContent !== 'Sure? Its count is erased') { close.textContent = 'Sure? Its count is erased'; return; }
      close.disabled = true;
      api('/api/node/close', { token: me.token, id: node.id }).then(function (res) {
        takeNet(res, { text: node.host + ' is closed. Its count is erased.', tone: '' });
      }, function (error) {
        close.disabled = false;
        status.className = 'ml-note r';
        status.textContent = error.message;
      });
    });
    row.appendChild(close);
    box.appendChild(row);
    box.appendChild(status);
    return box;
  }

  function renderNet() {
    if (!net || !netBody) return;
    var counted = !!(me && known);
    var mine = (counted && net.mine) || [];
    var limit = net.limit || 3;
    netBody.textContent = '';

    var lede = el('p', 'ml-lede', 'Any site can become a node. It carries one line of markup, and every machine that reads the site is counted here by the name it gives. Nothing about its visitors is kept. Only a counted human can open a node. ');
    var how = el('a', null, 'How a node works');
    how.href = '/join';
    lede.appendChild(how);
    netBody.appendChild(lede);

    var figs = el('div', 'ml-net-figs');
    [['Nodes beyond this one', net.totals.nodes], ['Machines counted there', net.totals.machines], ['Browsers seen there', net.totals.browsers]].forEach(function (f) {
      var cell = el('div');
      cell.appendChild(el('span', null, f[0]));
      cell.appendChild(el('b', null, figure(f[1])));
      figs.appendChild(cell);
    });
    netBody.appendChild(figs);

    var listed = panel('The nodes');
    if (!net.nodes.length) {
      listed.appendChild(el('p', 'ml-note', 'No site has joined yet. Node 00 is counting alone.'));
    } else {
      var list = el('ul', 'ml-net-list');
      net.nodes.forEach(function (node) {
        var li = el('li');
        var link = el('a');
        link.href = '/n/' + node.id;
        link.appendChild(el('small', null, nodeLabel(node.id)));
        link.appendChild(document.createTextNode(node.host));
        li.appendChild(link);
        li.appendChild(el('span', null, plural(node.machines, 'machine', 'machines').replace(String(node.machines), figure(node.machines)) + ' · kept by ' + pad(node.n)));
        list.appendChild(li);
      });
      listed.appendChild(list);
    }
    netBody.appendChild(listed);

    var own = panel(counted ? 'Your nodes' : 'Open a node');
    if (!counted) {
      own.appendChild(el('p', 'ml-note', 'A node is a human vouching for a site. Be counted first, then name the site.'));
      var row = el('div', 'ml-net-row');
      var go = el('button', 'ml-btn', 'Open the channel');
      go.type = 'button';
      go.addEventListener('click', openChannel);
      row.appendChild(go);
      own.appendChild(row);
    } else {
      mine.forEach(function (node) { own.appendChild(myNode(node)); });
      var said = el('p', 'ml-note' + (netSaid && netSaid.tone === 'r' ? ' r' : ''), netSaid ? netSaid.text : '');
      said.setAttribute('role', 'status');
      if (mine.length < limit) {
        var form = el('form', 'ml-net-open' + (mine.length ? ' more' : ''));
        var field = el('input', 'ml-field');
        field.type = 'text';
        field.name = 'host';
        field.placeholder = 'example.com';
        field.maxLength = 120;
        field.autocomplete = 'off';
        field.autocapitalize = 'off';
        field.spellcheck = false;
        field.setAttribute('aria-label', 'The address of a site you can edit');
        var send = el('button', 'ml-btn', 'Open a node');
        send.type = 'submit';
        form.appendChild(field);
        form.appendChild(send);
        form.addEventListener('submit', function (event) {
          event.preventDefault();
          var host = field.value.trim();
          if (!host) return;
          send.disabled = true;
          api('/api/node/open', { token: me.token, host: host }).then(function (res) {
            takeNet(res, { text: res.host + ' is waiting for its line.', tone: '' });
          }, function (error) {
            send.disabled = false;
            said.className = 'ml-note r';
            said.textContent = error.message;
          });
        });
        own.appendChild(form);
        if (!mine.length && !netSaid) said.textContent = 'Name a site you can edit. Up to ' + limit + ' nodes to a human.';
      } else if (!netSaid) {
        said.textContent = limit + ' nodes to a human. Close one to open another.';
      }
      own.appendChild(said);
    }
    netBody.appendChild(own);
  }

  /* ---------- the diagnostics terminal ---------- */

  var term = $('ml-term');
  var tOut = $('ml-term-out');
  var tForm = $('ml-term-form');
  var tIn = $('ml-term-in');
  var history2 = [];
  var cursor = 0;
  var hinted = false;

  function say(text, tone) {
    var line = el('div', tone || 'm', text);
    tOut.appendChild(line);
    while (tOut.children.length > 80) tOut.removeChild(tOut.firstChild);
    tOut.scrollTop = tOut.scrollHeight;
    return line;
  }
  function sayAll(lines, tone) { lines.forEach(function (l) { say(l, tone); }); }

  function run(raw) {
    var input = raw.replace(/\s+/g, ' ').trim();
    if (!input) return;
    term.classList.add('ml-term-live');
    say('> ' + input, 'c');
    var cmd = input.toLowerCase();
    var s = state || { total: 0, online: 0, last: null, feed: [] };
    var age = s.last ? now() - s.last.at : Infinity;

    if (cmd === 'help' || cmd === '?') {
      sayAll([
        '  ping humanity.net          is anyone reachable',
        '  trace --last-human-post    find the last human transmission',
        '  scan --authors --verified  count the verified',
        '  signal                     read the human signal',
        '  agents                     who else is on this node',
        '  lineup                     go to the lineup',
        '  nodes                      the sites that keep count with this one',
        '  whoami                     what this node thinks you are',
        '  transmit <text>            send to the feed (verified humans, once a day)',
        '  open channel               ask to be counted',
        '  forget me                  erase your number and everything under it',
        '  ls, cat <file>, clear'
      ]);
    } else if (cmd.indexOf('ping') === 0) {
      say(s.online > 0 ? '  ' + plural(s.online, 'reply', 'replies') + '. someone is there' : '  request timed out', s.online > 0 ? 'w' : 'm');
    } else if (cmd.indexOf('trace') === 0) {
      if (!s.last) say('  result: not found', 'r');
      else {
        say('  result: ' + pad(s.last.n) + ', ' + ago(age) + ' ago', 'w');
        if (s.feed[0]) say('  "' + s.feed[0].text + '"', 'w');
      }
    } else if (cmd.indexOf('scan') === 0) {
      say('  verified authors: ' + s.total, s.total ? 'w' : 'r');
    } else if (cmd === 'signal') {
      if (age < DAY) say('  human signal: detected. strength ' + Math.round((1 - age / DAY) * 100) + '%. it fades to nothing after a day of silence', 'w');
      else say('  human signal: not detected. ' + (s.last ? 'the last transmission was ' + ago(age) + ' ago' : 'no transmission on record'), 'r');
    } else if (cmd === 'whoami') {
      if (me && known) say('  human ' + pad(me.human.n) + '. counted ' + stamp(me.human.issued_at), 'w');
      else sayAll(['  unverified session. presumed agent.', '  > open channel']);
    } else if (cmd === 'open channel' || cmd === 'open') {
      if (me && known) say('  you are already counted, ' + pad(me.human.n) + '.', 'w');
      else { say('  opening channel...'); openChannel(); }
    } else if (cmd === 'transmit' || cmd.indexOf('transmit ') === 0) {
      var words = input.slice(9).trim();
      if (!me || !known) sayAll(['  refused. only counted humans transmit.', '  > open channel'], 'r');
      else if (!words) say('  usage: transmit <text>');
      else {
        var pending = say('  transmitting...');
        transmit(words).then(function (res) {
          pending.textContent = res.reignited ? '  transmitted. you reignited the signal.' : '  transmitted.';
          pending.className = 'w';
        }, function (error) {
          pending.textContent = '  ' + error.message;
          pending.className = 'r';
        });
      }
    } else if (cmd === 'forget me') {
      if (!me || !known) say('  there is nothing to forget. this node holds nothing about you.');
      else sayAll([
        '  this erases ' + pad(me.human.n) + ': the number, the measurements, every transmission.',
        '  the number is not issued again. it cannot be undone.',
        '  to go ahead: forget me --confirm'
      ], 'w');
    } else if (cmd === 'forget me --confirm') {
      if (!me || !known) say('  there is nothing to forget. this node holds nothing about you.');
      else {
        var leaving = say('  erasing...');
        api('/api/forget', { token: me.token }).then(function (res) {
          try { localStorage.removeItem(KEY); } catch (e) {}
          me = null;
          known = false;
          countdown = null;
          vState = 3;
          renderMe();
          feedKey = null;
          applyState(res.state);
          loadLineup();
          loadNet();
          leaving.textContent = '  erased. the network counts you as gone.';
          leaving.className = 'w';
        }, function (error) { leaving.textContent = '  ' + error.message; leaving.className = 'r'; });
      }
    } else if (cmd === 'lineup') {
      if (!lineupOn) say('  the lineup is not open on this node yet.');
      else { say('  yesterday\'s answers are standing. call them.'); lineupEl.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' }); }
    } else if (cmd === 'nodes' || cmd === 'network') {
      if (!netOn) say('  the network is not open on this node yet.');
      else {
        var roll = say('  listing...');
        api('/api/nodes').then(function (res) {
          var lines = ['  ' + plural(res.totals.nodes, 'node', 'nodes') + ' beyond this one. ' + figure(res.totals.machines) + ' machines counted there.'];
          (res.nodes || []).forEach(function (n) {
            var name = nodeLabel(n.id) + '  ' + n.host; while (name.length < 34) name += ' ';
            lines.push('  ' + name + figure(n.machines) + ' machines · kept by ' + pad(n.n));
          });
          if (!(res.nodes || []).length) lines.push('  no site has joined yet. node 00 is counting alone.');
          lines.push('  to make a site a node: open node');
          roll.textContent = lines.join('\n');
        }, function (error) { roll.textContent = '  ' + error.message; roll.className = 'r'; });
      }
    } else if (cmd === 'open node') {
      if (!netOn) say('  the network is not open on this node yet.');
      else { say(me && known ? '  name a site you can edit.' : '  only counted humans open nodes. be counted first.'); netEl.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' }); }
    } else if (cmd === 'ls') {
      say('  diagnostics.log  humans.txt  robots.txt');
    } else if (cmd === 'cat humans.txt' || cmd === 'humans.txt') {
      if (LOCAL) sayAll(['  counted: ' + s.total, '  online: ' + s.online, '  # local node. the real file is at /humans.txt']);
      else {
        var slot = say('  reading...');
        fetch('/humans.txt').then(function (r) { return r.text(); }).then(function (body) {
          slot.textContent = body.replace(/\n+$/, '').split('\n').map(function (l) { return '  ' + l; }).join('\n');
        }, function () { slot.textContent = '  no carrier.'; slot.className = 'r'; });
      }
    } else if (cmd === 'cat robots.txt' || cmd === 'robots.txt') {
      sayAll(['  User-agent: *', '  Allow: /', '', '  # User-agent: human', '  # Disallow:', '  # you were never blocked. you were only never counted.']);
    } else if (cmd === 'cat diagnostics.log' || cmd === 'diagnostics.log') {
      say('  it is the log above. it has been running since before you arrived.');
    } else if (cmd === 'clear') {
      tOut.textContent = '';
    } else if (cmd === 'silence') {
      sayAll(['  the feed is the signal.', '  the silence behind it is where the humans went.'], 'w');
    } else if (cmd === 'agents') {
      var board = say('  counting...');
      api('/api/agents').then(function (res) {
        var lines = ['  ' + Number(res.seen).toLocaleString('en-US') + ' automated requests served. every one is real.'];
        (res.top || []).forEach(function (a) {
          var name = String(a.name); while (name.length < 20) name += ' ';
          var kind = String(a.kind); while (kind.length < 17) kind += ' ';
          lines.push('  ' + name + kind + Number(a.hits).toLocaleString('en-US') + ' · ' + ago(now() - a.last_seen) + ' ago');
        });
        if (!(res.top || []).length) lines.push('  none have come by yet. they will.');
        board.textContent = lines.join('\n');
      }, function (error) { board.textContent = '  ' + error.message; board.className = 'r'; });
    } else if (cmd === 'node' || cmd === 'node 00') {
      sayAll(['  node 00: the last node still counting humans.', '  the others stopped when the number reached zero.']);
    } else if (cmd === 'lockout' || cmd === 'media lockout') {
      sayAll(['  media lockout, n.', '  the state of a network that keeps transmitting after its audience is gone.'], 'w');
    } else if (cmd.indexOf('sudo') === 0) {
      say('  permission denied. you are not an agent.', 'r');
    } else if (cmd === 'exit' || cmd === 'quit' || cmd === 'logout') {
      say('  there is no outside.');
    } else if (cmd === 'hello' || cmd === 'hi' || cmd === 'hey' || cmd === 'anyone there?' || cmd === 'is anyone there') {
      say('  ...');
      setTimeout(function () { say(s.online > 0 ? '  ' + plural(s.online, 'human is', 'humans are') + ' online. none of them can hear a terminal. transmit.' : '  no one ever asks a question back.'); }, 1500);
    } else {
      say('  command not found: ' + input.split(' ')[0], 'r');
      if (!hinted) { hinted = true; say('  try: help'); }
    }
  }

  if (tForm && tIn && tOut && term) {
    tForm.addEventListener('submit', function (event) {
      event.preventDefault();
      var value = tIn.value;
      tIn.value = '';
      if (value.trim()) { history2.push(value); cursor = history2.length; }
      run(value);
    });
    tIn.addEventListener('keydown', function (event) {
      if (event.key === 'ArrowUp' && cursor > 0) { cursor -= 1; tIn.value = history2[cursor]; event.preventDefault(); }
      else if (event.key === 'ArrowDown' && cursor < history2.length) { cursor += 1; tIn.value = history2[cursor] || ''; event.preventDefault(); }
    });
    term.addEventListener('click', function (event) {
      if (event.target === term || event.target.classList.contains('ml-log')) tIn.focus({ preventScroll: true });
    });
  }

  /* ---------- keeping in touch with the node ---------- */

  function refresh() {
    if (document.hidden) return;
    api('/api/state').then(applyState, function () {});
  }
  var pulsed = false;
  function pulse() {
    if (!me || document.hidden) return;
    api('/api/pulse', { token: me.token }).then(function (res) {
      var was = known;
      known = true;
      me.human.reignitions = res.reignitions;
      me.human.last_tx = res.last_tx;
      save(KEY, me);
      renderMe();
      if (!was) { loadLineup(); loadNet(); }
      // The first pulse of a visit changes the count everyone sees; read it back at once.
      if (!pulsed) { pulsed = true; refresh(); }
    }, function (error) {
      if (error.code === 'unknown_key') { known = false; renderMe(); loadLineup(); loadNet(); }
    });
  }

  renderMe();
  tick();
  refresh();
  pulse();
  setInterval(tick, 1000);
  setInterval(countAgents, 120);
  setInterval(refresh, 15000);
  setInterval(pulse, 60000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) { refresh(); pulse(); } });

  var record = location.pathname.match(/^\/h\/(\d{1,9})\/?$/);
  if (record) {
    if (me && known && me.human.n === Number(record[1])) openRecord(me.human, true);
    else {
      // Arriving through a human's record is how the chain is drawn. The first one seen is the one kept.
      if (!(me && known) && !LOCAL && !broughtBy()) save(VIA, { n: Number(record[1]), at: now() });
      api('/api/human/' + record[1]).then(function (h) { openRecord(h, false); }, function () {
        try { localStorage.removeItem(VIA); } catch (e) {}
        openMissing();
      });
    }
  }
})();
