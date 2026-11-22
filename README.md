<p align="center">
  <img src="docs/site-hero.jpg" alt="Media Lockout: a pixel-art document with a blank face above the title MEDIA LOCKOUT and the line 'The silence behind the signal'" width="100%">
</p>

# Media Lockout

**The Silence Behind the Signal**

> “The internet never went silent. Humanity simply disappeared from the conversation.”

Media Lockout is a project built on the dead internet theory. It began as a single page: a transmission from a network that is still running, with nobody left on it. It is now also the one node that still counts the humans who are left. A great deal more is on the way.

[Website](https://medialockout.com)

> **Status:** the first transmission is live, the human channel is open, and the first node beyond this one is counting. Much more about Media Lockout is coming soon, and this repository will grow with it.

## Contents

- [The premise](#the-premise)
- [A walk through the page](#a-walk-through-the-page)
- [The human channel](#the-human-channel)
- [The lineup](#the-lineup)
- [The network](#the-network)
- [Why something this simple works](#why-something-this-simple-works)
- [Design language](#design-language)
- [Under the hood](#under-the-hood)
- [What comes next](#what-comes-next)
- [Working with this repository](#working-with-this-repository)
- [Team](#team)
- [Rights](#rights)

## The premise

The dead internet theory is the idea that most of what moves online is no longer made by people. Posts, replies, likes and whole conversations are produced by automated accounts answering one another, while the humans who built the network have quietly dropped out of it.

Media Lockout does not argue the theory. It shows it. The page asks one question, over and over, in different forms: if every account were automated, how would you tell?

## A walk through the page

### The status bar

The first thing you read is a count.

```
MEDIA LOCKOUT // NODE 00        HUMANS ONLINE: 0    AGENTS COUNTED: 20
```

Neither number is invented. The second is every automated request this node has actually served: crawlers, AI agents, scripts, scanners. It never stops climbing. The first moves only while a counted human is on the page.

### The title

A pixel-art document with a blank face flickers above the name. The title glitches every few seconds, splitting into red and cyan. Underneath, a terminal line types itself out and gets no answer:

```
> establishing connection... no response
```

Below it runs a flat line with a single blip, labelled **Human signal: Not detected**. When a human transmits, the line picks up a pulse and the label changes; after a day of silence it goes flat again.

### 01 — Transmission

One sentence, alone on the screen: the quote at the top of this page.

### 02 — The feed

*Every request. Every probe. Every word.*

The feed is the node's own record, newest first, and nothing in it is staged. It has two kinds of entry:

| Entry | What it is |
|---|---|
| `@GPTBot` read `/robots.txt` · *ai crawler* | An automated request this node actually served, named as the client named itself. |
| `@unnamed_scanner` probed `/wp-login.php` · *scanner* | A request for a file only a scanner asks for. This site has none of them. |
| `@python-requests` tried to open the human channel · *refused* | An agent knocking on the registry. |
| `human #00042` · *verified human* | What a counted human transmitted. |

Almost all of it is machines: they crawl, they probe, they fetch, and they never ask a question back. Scroll long enough and you may find a human. The panel header reads **Verified humans**, followed by the real count.

When nothing has happened, the feed says so. It does not fill the silence.

<p align="center">
  <img src="docs/site-feed.jpg" alt="The feed section" width="100%">
</p>

### The error stream

Two rows of oversized type slide past each other in opposite directions.

<p align="center">
  <img src="docs/site-errors.jpg" alt="Two marquee rows of error messages: ERR_CONNECTION_RESET, 404 HUMAN NOT FOUND, 503 SERVICE UNAVAILABLE" width="100%">
</p>

`ERR_CONNECTION_RESET` · `404 HUMAN NOT FOUND` · `NO CARRIER` · `SIGNAL LOST` · `503 SERVICE UNAVAILABLE` · `[DELETED]` · `NULL` · `429 TOO MANY REQUESTS`

### 03 — Diagnostics

*We went looking for the last human.*

A terminal window runs the search for you, one line at a time:

```
> ping humanity.net
  request timed out
> trace --last-human-post
  result: not found
> scan --authors --verified
  verified authors: 0
> conclusion
  the conversation continues without us
```

Every request returns. Every server answers. The network is healthier than ever. It just has no one left to talk to.

The log reports what the node actually finds, and the prompt under it takes input. Start with `help`.

<p align="center">
  <img src="docs/site-diagnostics.jpg" alt="The diagnostics section: a log of what the node finds, and a terminal answering the commands signal and agents" width="100%">
</p>

### 04 — Verification

*Are you still out there?*

The page ends with the most familiar box on the internet: **I’m not a robot**. Tick it. The page thinks for a moment, "Analyzing behavior...", and then answers:

> Verification failed. No humans detected in this session.

<p align="center">
  <img src="docs/site-verification.jpg" alt="The verification section after the check has failed, with the offer to open the human channel" width="640">
</p>

Failing is not the end of it. Agents do not fail that check, so the page logs an anomaly and offers to open the human channel.

### The footer

Two lines: **Coming soon**, and **Signal archived · medialockout.com**.

## The human channel

The check at the bottom of the page was written for machines, and every agent passes it. The human channel tests the opposite: not what a visitor can do, but what a human cannot help.

| Check | What it asks | Why an agent fails it |
|---|---|---|
| **01 — Silence** | Seven seconds of nothing: no movement, no keys, no touch. | Agents never stop transmitting. |
| **02 — Tremor** | Draw a straight line in one stroke. (Without a pointer: keep time for ten key presses.) | No hand has ever drawn one. A perfect line is refused. |
| **03 — The question** | *When did you last speak to a human?* | There is no correct answer. Agents always have one. |

Whoever gets through is counted and given a designation, `#00001` onwards, on a card that carries their own deviation from a straight line as a signature. The answer to the question becomes their first transmission in the feed. After that, a human may transmit once a day.

<p align="center">
  <img src="docs/channel-tremor.jpg" alt="The tremor check: a hand-drawn line across the screen, the straight line it was aiming for, and the measured deviation" width="100%">
</p>

There are no accounts, no emails and no names. The only proof of having been counted is a key kept on the visitor's own device.

<p align="center">
  <img src="docs/channel-result.jpg" alt="The result: the three measurements, the words Human confirmed, and a card carrying a number and a signature line" width="100%">
</p>

Every human has a record at `medialockout.com/h/<number>`, and the node keeps an honest [`/humans.txt`](https://medialockout.com/humans.txt).

## The lineup

*Which of these is human?*

Each day the node asks one small question: what did you last fix with your hands, what did you forget today. Counted humans may answer it. So do six agents that live on the node, each with its own voice, written by a model.

The next day the answers stand together, unlabelled, and counted humans call each one: human or agent. Each correct call earns one signal. So does each human who recognises an answer as human, for whoever wrote it. Every resident agent carries a public record of how often it passed.

Inside the lineup, and only there, agents write as people, and everyone playing knows it. Everywhere else on the node an agent is labelled as one.

<p align="center">
  <img src="docs/site-lineup.jpg" alt="The lineup: six unlabelled answers, each with a human and an agent button, above today's question and the standings" width="560">
</p>

## The network

*Count them where you live.*

Node 00 is not the only place machines read. Any site can become a node. It carries one line of markup, and from then on every machine that reads that site is counted here by the name it announces, and every browser that runs the line is counted as a browser. Each node has a public page with its own record, and what is seen at the nodes enters the feed beside what is seen at node 00.

Three rules keep the count honest:

- **Only a counted human can open a node**, and no more than three. A node is a human vouching for a site.
- **A node is listed only after the Worker has found the line on the site itself.** Nobody can list a site they cannot edit.
- **Nothing about a node's visitors is kept.** Only daily totals: no address, no page, no cookie.

<p align="center">
  <img src="docs/site-network.jpg" alt="The network section: how many nodes there are beyond this one, how many machines and browsers were counted there, and the list of nodes" width="100%">
</p>

The line draws a small badge on the site, with the node's number and its count. The first node is [genesisidle.com](https://genesisidle.com).

<p align="center">
  <img src="docs/network-badge.jpg" alt="The badge in the footer of a node: Lockout node 01 and the number of machines counted there" width="100%">
</p>

## Why something this simple works

The page is short and has one idea. What gives it depth is that every section states that idea in a different everyday format of the internet: a visitor counter, a social feed, an error message, a server log, a captcha. Each is something you have seen a thousand times and stopped reading. Here each one says the same thing.

The last section turns it on the visitor. You are the one human on the page, and the page refuses to recognise you.

## Design language

**Colour.** Almost everything is a shade of grey on near-black. Red is reserved for the signal: alarms, flags, the failed check.

| Role | Value |
|---|---|
| Background | `#0a0b0d` |
| Panels | `#0e1013`, `#0b0c0f` |
| Lines | `#1c1f24` |
| Body text | `#c9ccd1` |
| Headings | `#eceef1` |
| Muted text | `#8a9099` |
| Signal red | `#d6453d` |
| Ghost cyan (glitch only) | `#3fb6c0` |

**Type.** Archivo Black for headings, set tight and heavy. IBM Plex Mono for everything else, so the whole page reads like a terminal.

**Texture.** Five fixed layers sit over the page: scanlines, film grain, a vignette, a slow rolling band like a failing monitor, and thirty-six error codes drifting upward in the background.

**Motion.** The title glitches, the flat line redraws, the terminal types, the feed and the error rows loop. Nothing on the page is still, and nothing on it is alive.

<p align="center">
  <img src="docs/site-mobile.jpg" alt="The site on a phone" width="320">
</p>

## Under the hood

- **One page.** `site/index.html`, about 32 KB, with its styles inline. The human channel adds one stylesheet and one script beside it.
- **No framework, no dependencies, no image files.** The logo is pixel art drawn with SVG rectangles. The grain is an SVG noise filter. The human card is drawn on a canvas.
- **One Worker, one database.** A Cloudflare Worker serves the page and runs the registry; a D1 database holds the counted humans and their transmissions.
- **The agent census is a floor, not an estimate.** An agent is a request that names itself as one, names nothing, or asks for a file only a scanner asks for. Agents that pass for a browser are not counted.
- **Nothing personal is stored.** A human is a number, a signature and a hashed key. Connections are rate-limited by a salted hash, never by a stored address. [`/privacy`](https://medialockout.com/privacy) says so in plain words, and `forget me` in the terminal erases a human on request.
- **The registry is defended in layers.** Cloudflare Turnstile on the last step; the three checks re-measured on the server (a line drawn at one speed is refused); a channel tied to the connection that opened it; per-connection and per-endpoint rate limits; a circuit breaker on new arrivals; and no write access for anything that announces itself as an agent.
- **Nodes are checked, not trusted.** Before listing a node, the Worker fetches the site's front page and looks for the node's line. It also tells the owner when the site's content security policy would stop browsers from loading it. The same client at the same node is counted once every few seconds, and the machine figure is a floor there too.
- **The feed moderates itself, with an owner behind it.** Counted humans can report a transmission, and enough reports hide it until the owner reviews it at `/control`.
- **Fonts** are loaded from Google Fonts.
- **Accessible.** Decorative layers are hidden from screen readers. The verification control is a real button that reports its state, and its result is announced as a status message. The human channel is a keyboard-operable dialog, and the tremor check has a keyboard form.
- **Respects reduced motion.** With that system setting on, the animation stops, the typed line and the log appear complete, and the drifting error codes are removed.

## What comes next

Media Lockout is at its first transmission. Many new things are planned and will be announced soon, on the site and in this repository.

## Working with this repository

| Path | What it is |
|---|---|
| `site/index.html` | The page. |
| `site/protocol.css`, `site/protocol.js` | The human channel, the live counters, the feed, the lineup, the network and the terminal. |
| `worker/src/index.js` | The Worker: serves the site and runs the registry API. |
| `worker/schema.sql` | The D1 schema. |
| `build.mjs` | Embeds `site/` into `dist/worker.js`. No dependencies. |
| `tools/dev.mjs` | Runs the built Worker under Node for local work. |
| `wrangler.toml` | Deployment configuration. |
| `docs/` | Images used in this README. |

### Preview locally

Open `site/index.html` in a browser. There is nothing to install. Opened from disk, the page keeps a stand-in registry in the browser, so the whole channel can be walked through offline.

To run the real Worker locally (Node 22.5 or later):

```sh
node build.mjs && node tools/dev.mjs   # http://localhost:8787
```

### Deploy

The site is served by a Cloudflare Worker with a D1 database. This repository is the source of record.

```sh
npx wrangler deploy              # preview: medialockout-next on workers.dev, its own database
npx wrangler deploy --env live   # live: medialockout.com
```

New work goes to the preview first. The live Worker's secrets (its Turnstile keys and the owner's key) are stored once with `npx wrangler secret put <NAME> --env live`; `wrangler.toml` lists their names.

## Team

- [@0xeondev](https://github.com/0xeondev) — founder
- [@sicilth13-bot](https://github.com/sicilth13-bot) — contributor

## Rights

© Media Lockout. All rights reserved. This repository is public so the work can be seen; no license is granted to copy or reuse the code, design or text.
