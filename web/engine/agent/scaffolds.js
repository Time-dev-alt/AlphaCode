/**
 * Scaffolds — complete, working starter apps written deterministically.
 *
 * This is the cheapest work the product can possibly do. A model asked for "a
 * landing page" spends thousands of output tokens and several round trips
 * inventing markup it has generated ten thousand times before. The same page is
 * already here, in full, so the `scaffold` tool writes it in **one tool call,
 * zero tokens of content**, and the model's budget is spent on what is actually
 * new about the request.
 *
 * It is also the parity feature: choosing a template in the gallery used to
 * send a prompt and wait; it now produces a finished app before the model is
 * involved at all.
 *
 * Every template is three real files, responsive, accessible, and works offline
 * in the preview sandbox — no CDN, no build step, no framework.
 */

/** Shared design tokens, so every scaffold looks like the same product. */
const BASE = `:root {
  color-scheme: dark light;
  --bg: #0b0c10;
  --bg-2: #101219;
  --panel: #14161f;
  --raise: #1b1e29;
  --fg: #eceff5;
  --fg-2: #a6aec0;
  --fg-3: #6f7789;
  --line: #232734;
  --line-2: #2e3342;
  --accent: #f5a524;
  --accent-2: #ff7a45;
  --ok: #2fbf71;
  --err: #f2555a;
  --radius: 14px;
  --shadow: 0 24px 60px -32px rgba(0, 0, 0, 0.9);
  --font: "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: light) {
  :root {
    --bg: #fbfbfd;
    --bg-2: #f4f5f8;
    --panel: #ffffff;
    --raise: #f2f3f7;
    --fg: #14161c;
    --fg-2: #4c5462;
    --fg-3: #7b8394;
    --line: #e5e7ee;
    --line-2: #d7dae3;
    --shadow: 0 24px 60px -36px rgba(16, 20, 32, 0.28);
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; scroll-behavior: smooth; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font-family: var(--font);
  font-size: 16px;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}
img, svg, canvas { display: block; max-width: 100%; }
a { color: inherit; text-decoration: none; }
button, input, textarea, select { font: inherit; color: inherit; }
h1, h2, h3, h4 { margin: 0; line-height: 1.15; letter-spacing: -0.022em; font-weight: 640; }
p { margin: 0; }
.wrap { width: 100%; max-width: 1120px; margin: 0 auto; padding: 0 24px; }
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 42px;
  padding: 0 18px;
  border: 1px solid var(--line-2);
  border-radius: 10px;
  background: var(--panel);
  color: var(--fg);
  font-size: 14.5px;
  font-weight: 550;
  cursor: pointer;
  transition: transform 0.12s ease, background 0.16s ease, border-color 0.16s ease;
}
.btn:hover { background: var(--raise); border-color: var(--fg-3); }
.btn:active { transform: translateY(1px); }
.btn.primary {
  background: linear-gradient(180deg, var(--accent), var(--accent-2));
  border-color: transparent;
  color: #1a1205;
  font-weight: 640;
}
.btn.primary:hover { filter: brightness(1.06); }
.btn.ghost { background: transparent; border-color: transparent; color: var(--fg-2); }
.btn.ghost:hover { color: var(--fg); background: var(--raise); }
.card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
}
.muted { color: var(--fg-2); }
.tiny { font-size: 12.5px; color: var(--fg-3); }
.badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  padding: 0 10px;
  border-radius: 999px;
  border: 1px solid var(--line-2);
  background: var(--raise);
  color: var(--fg-2);
  font-size: 12px;
  font-weight: 550;
}
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 6px; }
@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  * { animation-duration: 0.001ms !important; transition-duration: 0.001ms !important; }
}
`;

/* ── landing ──────────────────────────────────────────────────────────────── */

const LANDING_CSS = `
.nav {
  position: sticky;
  top: 0;
  z-index: 20;
  border-bottom: 1px solid transparent;
  background: color-mix(in srgb, var(--bg) 82%, transparent);
  backdrop-filter: saturate(1.4) blur(14px);
  transition: border-color 0.2s ease;
}
.nav.scrolled { border-bottom-color: var(--line); }
.nav-in { display: flex; align-items: center; gap: 28px; height: 64px; }
.brand { display: flex; align-items: center; gap: 10px; font-weight: 680; letter-spacing: -0.02em; }
.brand-mark {
  width: 26px; height: 26px; border-radius: 8px;
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
  box-shadow: 0 6px 18px -8px var(--accent);
}
.nav-links { display: flex; gap: 22px; margin-left: auto; }
.nav-links a { color: var(--fg-2); font-size: 14.5px; }
.nav-links a:hover { color: var(--fg); }
.nav-cta { display: flex; gap: 8px; }
.nav-toggle { display: none; }
@media (max-width: 820px) {
  .nav-links { display: none; position: absolute; top: 64px; left: 0; right: 0;
    flex-direction: column; gap: 0; padding: 8px 24px 16px;
    background: var(--bg-2); border-bottom: 1px solid var(--line); }
  .nav-links.open { display: flex; }
  .nav-links a { padding: 10px 0; border-bottom: 1px solid var(--line); }
  .nav-toggle { display: inline-flex; margin-left: auto; }
  .nav-cta .btn:not(.primary) { display: none; }
}
.hero { position: relative; padding: clamp(56px, 9vw, 104px) 0 clamp(48px, 7vw, 80px); overflow: hidden; }
.hero::before {
  content: '';
  position: absolute; inset: -20% 20% auto;
  height: 520px;
  background: radial-gradient(closest-side, color-mix(in srgb, var(--accent) 24%, transparent), transparent 72%);
  filter: blur(20px);
  pointer-events: none;
}
.hero-in { position: relative; display: grid; gap: 26px; justify-items: center; text-align: center; max-width: 780px; margin: 0 auto; }
.hero h1 { font-size: clamp(2.3rem, 6vw, 3.9rem); letter-spacing: -0.035em; }
.hero h1 em {
  font-style: normal;
  background: linear-gradient(100deg, var(--accent), var(--accent-2) 70%);
  -webkit-background-clip: text; background-clip: text; color: transparent;
}
.hero p { font-size: clamp(1rem, 1.6vw, 1.15rem); color: var(--fg-2); max-width: 620px; }
.hero-actions { display: flex; flex-wrap: wrap; gap: 10px; justify-content: center; }
.stats { display: flex; flex-wrap: wrap; gap: 34px; justify-content: center; padding-top: 8px; }
.stat strong { display: block; font-size: 1.6rem; letter-spacing: -0.03em; }
.stat span { font-size: 12.5px; color: var(--fg-3); }
.logos { display: flex; flex-wrap: wrap; gap: 28px 44px; justify-content: center; padding: 30px 0 0; opacity: 0.55; }
.logos span { font-weight: 640; letter-spacing: -0.01em; }
section { padding: clamp(48px, 7vw, 84px) 0; }
.section-head { max-width: 640px; margin: 0 auto clamp(28px, 4vw, 44px); text-align: center; }
.section-head h2 { font-size: clamp(1.6rem, 3.4vw, 2.35rem); }
.section-head p { margin-top: 12px; color: var(--fg-2); }
.features { display: grid; gap: 16px; grid-template-columns: repeat(3, minmax(0, 1fr)); }
@media (max-width: 860px) { .features { grid-template-columns: minmax(0, 1fr); } }
.feature { padding: 24px; border-radius: var(--radius); border: 1px solid var(--line); background: var(--panel); }
.feature .ico {
  width: 38px; height: 38px; border-radius: 11px; display: grid; place-items: center; margin-bottom: 16px;
  background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent);
}
.feature h3 { font-size: 1.05rem; margin-bottom: 6px; }
.feature p { color: var(--fg-2); font-size: 14.5px; }
.pricing { display: grid; gap: 16px; grid-template-columns: repeat(3, minmax(0, 1fr)); align-items: start; }
@media (max-width: 860px) { .pricing { grid-template-columns: minmax(0, 1fr); } }
.plan { padding: 26px; border-radius: var(--radius); border: 1px solid var(--line); background: var(--panel); display: grid; gap: 14px; }
.plan.best { border-color: color-mix(in srgb, var(--accent) 55%, var(--line)); box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 30%, transparent), var(--shadow); }
.plan .price { font-size: 2.1rem; font-weight: 660; letter-spacing: -0.035em; }
.plan .price small { font-size: 0.9rem; font-weight: 500; color: var(--fg-3); }
.plan ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 9px; font-size: 14.5px; color: var(--fg-2); }
.plan li { display: flex; gap: 9px; align-items: flex-start; }
.plan li svg { flex: none; margin-top: 4px; color: var(--ok); }
.cta-band {
  border-radius: 20px; padding: clamp(30px, 5vw, 52px); text-align: center;
  background: linear-gradient(140deg, color-mix(in srgb, var(--accent) 18%, var(--panel)), var(--panel) 62%);
  border: 1px solid var(--line-2);
}
.cta-band h2 { font-size: clamp(1.5rem, 3vw, 2.1rem); }
.cta-band p { margin: 10px auto 22px; color: var(--fg-2); max-width: 520px; }
footer { border-top: 1px solid var(--line); padding: 34px 0; }
.foot-in { display: flex; flex-wrap: wrap; gap: 16px; align-items: center; justify-content: space-between; color: var(--fg-3); font-size: 13.5px; }
.foot-links { display: flex; gap: 20px; }
.reveal { opacity: 0; transform: translateY(14px); transition: opacity 0.5s ease, transform 0.5s ease; }
.reveal.in { opacity: 1; transform: none; }
`;

const LANDING_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Nimbus — ship your product, not your infrastructure</title>
  <meta name="description" content="Nimbus is the deployment platform for small teams: push, preview, and ship without a DevOps hire." />
  <link rel="stylesheet" href="style.css" />
</head>
<body>
  <header class="nav" id="nav">
    <div class="wrap nav-in">
      <a class="brand" href="#top"><span class="brand-mark"></span> Nimbus</a>
      <nav class="nav-links" id="nav-links" aria-label="Main">
        <a href="#features">Features</a>
        <a href="#pricing">Pricing</a>
        <a href="#faq">FAQ</a>
      </nav>
      <div class="nav-cta">
        <a class="btn ghost" href="#pricing">Sign in</a>
        <a class="btn primary" href="#pricing">Start free</a>
        <button class="btn ghost nav-toggle" id="nav-toggle" aria-expanded="false" aria-controls="nav-links">Menu</button>
      </div>
    </div>
  </header>

  <main id="top">
    <section class="hero">
      <div class="wrap hero-in">
        <span class="badge">New · previews in under 300 ms</span>
        <h1>Ship the product.<br /><em>Not the infrastructure.</em></h1>
        <p>Nimbus gives small teams previews on every branch, instant rollbacks, and edge hosting — without hiring anyone to run it.</p>
        <div class="hero-actions">
          <a class="btn primary" href="#pricing">Start free — no card</a>
          <a class="btn" href="#features">See how it works</a>
        </div>
        <div class="stats">
          <div class="stat"><strong>300 ms</strong><span>cold start</span></div>
          <div class="stat"><strong>99.99 %</strong><span>uptime, 12 months</span></div>
          <div class="stat"><strong>4,200+</strong><span>teams shipping</span></div>
        </div>
        <div class="logos" aria-label="Trusted by">
          <span>Northwind</span><span>Kestrel</span><span>Fathom</span><span>Orbit Labs</span><span>Plain&nbsp;Co</span>
        </div>
      </div>
    </section>

    <section id="features">
      <div class="wrap">
        <div class="section-head reveal">
          <h2>Everything the deploy needs. Nothing it doesn't.</h2>
          <p>Three things, done properly, instead of thirty things done badly.</p>
        </div>
        <div class="features">
          <article class="feature reveal">
            <div class="ico" aria-hidden="true">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M13 2 3 14h7l-1 8 10-12h-7l1-8Z" /></svg>
            </div>
            <h3>Instant previews</h3>
            <p>Every push gets a URL. Share it, click it, and see exactly what your users will see — with logs one keystroke away.</p>
          </article>
          <article class="feature reveal">
            <div class="ico" aria-hidden="true">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /></svg>
            </div>
            <h3>One-click rollback</h3>
            <p>Bad release? Restore the previous build in a second. No rebuild, no cache dance, no incident channel.</p>
          </article>
          <article class="feature reveal">
            <div class="ico" aria-hidden="true">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3v18M5 8l7-5 7 5M5 16l7 5 7-5" /></svg>
            </div>
            <h3>Edge by default</h3>
            <p>Your app runs close to your users in 300 cities. No config, no regions to pick, no egress bill to explain.</p>
          </article>
        </div>
      </div>
    </section>

    <section id="pricing">
      <div class="wrap">
        <div class="section-head reveal">
          <h2>Pricing that fits a side project</h2>
          <p>Start free. Pay when it is actually making you money.</p>
        </div>
        <div class="pricing">
          <article class="plan reveal">
            <div><h3>Hobby</h3><p class="tiny">For experiments</p></div>
            <div class="price">$0<small>/mo</small></div>
            <ul>
              <li>1 project</li><li>Preview deploys</li><li>Community support</li>
            </ul>
            <a class="btn" href="#">Start free</a>
          </article>
          <article class="plan best reveal">
            <div><h3>Pro <span class="badge">Popular</span></h3><p class="tiny">For shipping teams</p></div>
            <div class="price">$19<small>/mo</small></div>
            <ul>
              <li>Unlimited projects</li><li>Custom domains</li><li>Instant rollback</li><li>Email support</li>
            </ul>
            <a class="btn primary" href="#">Start 14-day trial</a>
          </article>
          <article class="plan reveal">
            <div><h3>Team</h3><p class="tiny">For companies</p></div>
            <div class="price">$49<small>/mo</small></div>
            <ul>
              <li>Everything in Pro</li><li>SSO &amp; audit log</li><li>Priority support</li>
            </ul>
            <a class="btn" href="#">Talk to us</a>
          </article>
        </div>
      </div>
    </section>

    <section id="faq">
      <div class="wrap">
        <div class="cta-band reveal">
          <h2>Your next deploy is 300 milliseconds away</h2>
          <p>Connect a repo, push a branch, and get a URL. That is the whole setup.</p>
          <a class="btn primary" href="#">Start free</a>
        </div>
      </div>
    </section>
  </main>

  <footer>
    <div class="wrap foot-in">
      <span>© <span id="year">2026</span> Nimbus Labs</span>
      <div class="foot-links">
        <a href="#features">Features</a><a href="#pricing">Pricing</a><a href="#">Privacy</a>
      </div>
    </div>
  </footer>

  <script src="app.js"></script>
</body>
</html>
`;

const LANDING_JS = `// Nav: mobile menu, shadow on scroll, reveal-on-scroll. No dependencies.
const nav = document.getElementById('nav');
const toggle = document.getElementById('nav-toggle');
const links = document.getElementById('nav-links');

toggle?.addEventListener('click', () => {
  const open = links.classList.toggle('open');
  toggle.setAttribute('aria-expanded', String(open));
});

for (const link of links?.querySelectorAll('a') || []) {
  link.addEventListener('click', () => {
    links.classList.remove('open');
    toggle?.setAttribute('aria-expanded', 'false');
  });
}

const onScroll = () => nav?.classList.toggle('scrolled', window.scrollY > 8);
onScroll();
window.addEventListener('scroll', onScroll, { passive: true });

const year = document.getElementById('year');
if (year) year.textContent = String(new Date().getFullYear());

const observer = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        entry.target.classList.add('in');
        observer.unobserve(entry.target);
      }
    }
  },
  { rootMargin: '0px 0px -10% 0px' }
);
for (const node of document.querySelectorAll('.reveal')) observer.observe(node);
`;

/* ── dashboard ────────────────────────────────────────────────────────────── */

const DASH_CSS = `
.shell { display: grid; grid-template-columns: 236px minmax(0, 1fr); min-height: 100vh; }
@media (max-width: 900px) {
  .shell { grid-template-columns: minmax(0, 1fr); }
  .side { position: fixed; inset: 0 auto 0 0; width: 260px; z-index: 30; transform: translateX(-100%); transition: transform 0.2s ease; }
  .side.open { transform: none; box-shadow: var(--shadow); }
  .menu-btn { display: inline-flex !important; }
}
.side { background: var(--bg-2); border-right: 1px solid var(--line); padding: 18px 14px; display: flex; flex-direction: column; gap: 22px; }
.brand { display: flex; align-items: center; gap: 10px; font-weight: 680; padding: 0 6px; }
.brand-mark { width: 24px; height: 24px; border-radius: 7px; background: linear-gradient(135deg, var(--accent), var(--accent-2)); }
.side nav { display: grid; gap: 3px; }
.side a {
  display: flex; align-items: center; gap: 10px; height: 36px; padding: 0 10px;
  border-radius: 9px; color: var(--fg-2); font-size: 14px;
}
.side a:hover { background: var(--raise); color: var(--fg); }
.side a.active { background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--fg); font-weight: 550; }
.side .foot { margin-top: auto; display: flex; align-items: center; gap: 10px; padding: 10px; border-radius: 10px; background: var(--raise); }
.avatar { width: 28px; height: 28px; border-radius: 50%; background: linear-gradient(135deg, #6aa7ff, #b06bff); flex: none; }
.main { min-width: 0; display: flex; flex-direction: column; }
.top {
  display: flex; align-items: center; gap: 12px; padding: 14px 22px;
  border-bottom: 1px solid var(--line); position: sticky; top: 0;
  background: color-mix(in srgb, var(--bg) 88%, transparent); backdrop-filter: blur(12px); z-index: 10;
}
.top h1 { font-size: 1.15rem; }
.search { margin-left: auto; display: flex; align-items: center; gap: 8px; padding: 0 10px; height: 34px;
  border: 1px solid var(--line); border-radius: 9px; background: var(--panel); color: var(--fg-3); }
.search input { border: 0; background: none; outline: none; width: 160px; font-size: 13.5px; }
@media (max-width: 640px) { .search { display: none; } }
.menu-btn { display: none; }
.content { padding: 22px; display: grid; gap: 18px; align-content: start; }
.grid-4 { display: grid; gap: 14px; grid-template-columns: repeat(4, minmax(0, 1fr)); }
@media (max-width: 1100px) { .grid-4 { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 520px) { .grid-4 { grid-template-columns: minmax(0, 1fr); } }
.stat { padding: 16px 18px; border-radius: var(--radius); border: 1px solid var(--line); background: var(--panel); display: grid; gap: 6px; }
.stat .label { font-size: 12.5px; color: var(--fg-3); }
.stat .value { font-size: 1.65rem; font-weight: 660; letter-spacing: -0.03em; }
.stat .delta { font-size: 12.5px; font-weight: 550; }
.stat .delta.up { color: var(--ok); }
.stat .delta.down { color: var(--err); }
.stat canvas { width: 100%; height: 34px; margin-top: 4px; }
.panel { border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); overflow: hidden; }
.panel-head { display: flex; align-items: center; gap: 10px; padding: 14px 18px; border-bottom: 1px solid var(--line); }
.panel-head h2 { font-size: 0.95rem; font-weight: 600; }
.panel-head .btn { margin-left: auto; height: 30px; padding: 0 12px; font-size: 13px; }
.split { display: grid; gap: 18px; grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr); align-items: start; }
@media (max-width: 1000px) { .split { grid-template-columns: minmax(0, 1fr); } }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th { text-align: left; font-weight: 550; font-size: 12.5px; color: var(--fg-3); padding: 10px 18px; border-bottom: 1px solid var(--line); }
td { padding: 12px 18px; border-bottom: 1px solid var(--line); color: var(--fg-2); }
tr:last-child td { border-bottom: 0; }
td strong { color: var(--fg); font-weight: 550; }
.pill { display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 9px; border-radius: 999px; font-size: 11.5px; font-weight: 550; }
.pill.paid { background: color-mix(in srgb, var(--ok) 16%, transparent); color: var(--ok); }
.pill.pending { background: color-mix(in srgb, var(--accent) 16%, transparent); color: var(--accent); }
.pill.refunded { background: color-mix(in srgb, var(--err) 14%, transparent); color: var(--err); }
.rows { display: grid; }
.row { display: flex; align-items: center; gap: 12px; padding: 12px 18px; border-bottom: 1px solid var(--line); }
.row:last-child { border-bottom: 0; }
.row .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ok); flex: none; }
.row .grow { min-width: 0; }
.row .grow b { display: block; font-weight: 550; font-size: 13.5px; }
.row .grow span { font-size: 12px; color: var(--fg-3); }
canvas.chart { width: 100%; height: 210px; display: block; }
`;

const DASH_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Console — Overview</title>
  <link rel="stylesheet" href="style.css" />
</head>
<body>
  <div class="shell">
    <aside class="side" id="side">
      <div class="brand"><span class="brand-mark"></span> Console</div>
      <nav aria-label="Sections">
        <a class="active" href="#">Overview</a>
        <a href="#">Orders</a>
        <a href="#">Customers</a>
        <a href="#">Products</a>
        <a href="#">Settings</a>
      </nav>
      <div class="foot">
        <span class="avatar" aria-hidden="true"></span>
        <div><b style="font-size:13px">Ada Okafor</b><div class="tiny">Owner</div></div>
      </div>
    </aside>

    <div class="main">
      <header class="top">
        <button class="btn ghost menu-btn" id="menu-btn" aria-label="Open menu">☰</button>
        <h1>Overview</h1>
        <label class="search">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          <input type="search" id="q" placeholder="Search orders…" aria-label="Search orders" />
        </label>
        <button class="btn" id="theme">Theme</button>
      </header>

      <div class="content">
        <div class="grid-4">
          <div class="stat"><span class="label">Revenue today</span><span class="value">$8,420</span><span class="delta up">▲ 12.4 % vs yesterday</span><canvas data-spark="1" aria-hidden="true"></canvas></div>
          <div class="stat"><span class="label">Orders</span><span class="value">312</span><span class="delta up">▲ 6.1 %</span><canvas data-spark="2" aria-hidden="true"></canvas></div>
          <div class="stat"><span class="label">Conversion</span><span class="value">3.8 %</span><span class="delta down">▼ 0.3 pp</span><canvas data-spark="3" aria-hidden="true"></canvas></div>
          <div class="stat"><span class="label">Refunds</span><span class="value">4</span><span class="delta up">0.9 % of orders</span><canvas data-spark="4" aria-hidden="true"></canvas></div>
        </div>

        <div class="split">
          <section class="panel">
            <div class="panel-head"><h2>Revenue, last 30 days</h2><button class="btn" id="range">30d</button></div>
            <canvas class="chart" id="chart" aria-label="Revenue chart"></canvas>
          </section>
          <section class="panel">
            <div class="panel-head"><h2>Activity</h2></div>
            <div class="rows">
              <div class="row"><span class="dot"></span><div class="grow"><b>New order #4821</b><span>Ada Okafor · 2 min ago</span></div></div>
              <div class="row"><span class="dot"></span><div class="grow"><b>Payment captured</b><span>$184.00 · 6 min ago</span></div></div>
              <div class="row"><span class="dot"></span><div class="grow"><b>Refund issued</b><span>#4799 · 22 min ago</span></div></div>
              <div class="row"><span class="dot"></span><div class="grow"><b>Inventory low</b><span>Espresso beans · 1 h ago</span></div></div>
            </div>
          </section>
        </div>

        <section class="panel">
          <div class="panel-head"><h2>Recent orders</h2><button class="btn">Export</button></div>
          <table>
            <thead><tr><th>Order</th><th>Customer</th><th>Status</th><th>Total</th></tr></thead>
            <tbody id="orders">
              <tr><td><strong>#4821</strong></td><td>Ada Okafor</td><td><span class="pill paid">Paid</span></td><td>$184.00</td></tr>
              <tr><td><strong>#4820</strong></td><td>Jonas Lind</td><td><span class="pill pending">Pending</span></td><td>$59.00</td></tr>
              <tr><td><strong>#4819</strong></td><td>Mira Shah</td><td><span class="pill paid">Paid</span></td><td>$212.50</td></tr>
              <tr><td><strong>#4818</strong></td><td>Tomás Reyes</td><td><span class="pill refunded">Refunded</span></td><td>$36.00</td></tr>
              <tr><td><strong>#4817</strong></td><td>Wei Chen</td><td><span class="pill paid">Paid</span></td><td>$98.00</td></tr>
            </tbody>
          </table>
        </section>
      </div>
    </div>
  </div>
  <script src="app.js"></script>
</body>
</html>
`;

const DASH_JS = `// Sparklines + chart drawn with canvas: no chart library, no CDN.
const series = {
  1: [12, 18, 15, 22, 19, 28, 24, 31, 29, 36],
  2: [8, 9, 7, 12, 11, 13, 12, 16, 15, 18],
  3: [4, 5, 5, 3, 4, 3, 4, 3, 3, 4],
  4: [2, 1, 3, 2, 1, 2, 2, 1, 3, 2],
};

function drawSpark(canvas, data) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 160;
  const h = canvas.clientHeight || 34;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext && canvas.getContext('2d');
  if (!ctx) return;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  const max = Math.max(...data);
  const min = Math.min(...data);
  const span = max - min || 1;
  const x = (i) => (i / (data.length - 1)) * w;
  const y = (v) => h - 3 - ((v - min) / span) * (h - 6);

  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, 'rgba(245,165,36,0.35)');
  grad.addColorStop(1, 'rgba(245,165,36,0)');
  ctx.beginPath();
  ctx.moveTo(0, h);
  data.forEach((v, i) => ctx.lineTo(x(i), y(v)));
  ctx.lineTo(w, h);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.beginPath();
  data.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
  ctx.strokeStyle = '#f5a524';
  ctx.lineWidth = 1.6;
  ctx.stroke();
}

function drawChart(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 600;
  const h = canvas.clientHeight || 210;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext && canvas.getContext('2d');
  if (!ctx) return;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const data = Array.from({ length: 30 }, (_, i) => 4200 + Math.sin(i / 3) * 900 + i * 110 + ((i * 37) % 400));
  const max = Math.max(...data) * 1.08;
  const pad = 28;
  const x = (i) => pad + (i / (data.length - 1)) * (w - pad * 2);
  const y = (v) => h - 26 - (v / max) * (h - 46);

  ctx.strokeStyle = 'rgba(127,135,153,0.18)';
  ctx.lineWidth = 1;
  for (let g = 0; g < 4; g++) {
    const gy = 20 + (g / 4) * (h - 46);
    ctx.beginPath();
    ctx.moveTo(pad, gy);
    ctx.lineTo(w - pad, gy);
    ctx.stroke();
  }

  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, 'rgba(245,165,36,0.28)');
  grad.addColorStop(1, 'rgba(245,165,36,0.02)');
  ctx.beginPath();
  ctx.moveTo(x(0), h - 26);
  data.forEach((v, i) => ctx.lineTo(x(i), y(v)));
  ctx.lineTo(x(data.length - 1), h - 26);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.beginPath();
  data.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
  ctx.strokeStyle = '#f5a524';
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.stroke();

  const last = data[data.length - 1];
  ctx.beginPath();
  ctx.arc(x(data.length - 1), y(last), 4, 0, Math.PI * 2);
  ctx.fillStyle = '#f5a524';
  ctx.fill();
}

const paint = () => {
  for (const canvas of document.querySelectorAll('canvas[data-spark]')) {
    drawSpark(canvas, series[canvas.dataset.spark] || series[1]);
  }
  const chart = document.getElementById('chart');
  if (chart) drawChart(chart);
};
paint();
window.addEventListener('resize', paint);

document.getElementById('theme')?.addEventListener('click', () => {
  document.documentElement.classList.toggle('light');
  document.documentElement.style.colorScheme = document.documentElement.classList.contains('light') ? 'light' : 'dark';
  paint();
});

document.getElementById('menu-btn')?.addEventListener('click', () => {
  document.getElementById('side')?.classList.toggle('open');
});

document.getElementById('q')?.addEventListener('input', (event) => {
  const term = event.target.value.trim().toLowerCase();
  for (const row of document.querySelectorAll('#orders tr')) {
    row.style.display = row.textContent.toLowerCase().includes(term) ? '' : 'none';
  }
});
`;

/* ── todo ─────────────────────────────────────────────────────────────────── */

const TODO_CSS = `
.app { min-height: 100vh; display: grid; place-items: start center; padding: clamp(24px, 8vh, 80px) 20px; }
.card {
  width: 100%; max-width: 560px; background: var(--panel); border: 1px solid var(--line);
  border-radius: 18px; box-shadow: var(--shadow); overflow: hidden;
}
.head { padding: 22px 22px 16px; border-bottom: 1px solid var(--line); }
.head h1 { font-size: 1.4rem; }
.head p { color: var(--fg-3); font-size: 13px; margin-top: 4px; }
.composer { display: flex; gap: 8px; padding: 16px 22px; }
.composer input {
  flex: 1; height: 42px; padding: 0 14px; border-radius: 10px;
  border: 1px solid var(--line-2); background: var(--bg-2); outline: none;
}
.composer input:focus { border-color: var(--accent); }
.filters { display: flex; gap: 4px; padding: 0 22px 12px; }
.filters button {
  height: 28px; padding: 0 11px; border-radius: 999px; border: 1px solid transparent;
  background: none; color: var(--fg-3); font-size: 12.5px; cursor: pointer;
}
.filters button.active { background: var(--raise); color: var(--fg); border-color: var(--line); }
ul.list { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--line); }
li.item { display: flex; align-items: center; gap: 12px; padding: 13px 22px; border-bottom: 1px solid var(--line); }
li.item:hover { background: var(--bg-2); }
.check {
  width: 20px; height: 20px; flex: none; border-radius: 6px; border: 1.5px solid var(--line-2);
  background: none; cursor: pointer; display: grid; place-items: center; color: transparent;
}
.check:hover { border-color: var(--accent); }
.item.done .check { background: var(--ok); border-color: var(--ok); color: #04170d; }
.item .text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.item.done .text { color: var(--fg-3); text-decoration: line-through; }
.del { border: 0; background: none; color: var(--fg-3); cursor: pointer; opacity: 0; padding: 4px; border-radius: 6px; }
.item:hover .del, .item:focus-within .del { opacity: 1; }
.del:hover { color: var(--err); background: color-mix(in srgb, var(--err) 12%, transparent); }
.empty { padding: 42px 22px; text-align: center; color: var(--fg-3); }
.empty strong { display: block; color: var(--fg-2); margin-bottom: 4px; font-weight: 550; }
.foot { display: flex; align-items: center; gap: 10px; padding: 12px 22px; font-size: 12.5px; color: var(--fg-3); }
.foot .clear { margin-left: auto; border: 0; background: none; color: var(--fg-3); cursor: pointer; font-size: 12.5px; }
.foot .clear:hover { color: var(--err); }
@media (max-width: 480px) { .composer { padding: 14px 16px; } .head { padding: 18px 16px 14px; } li.item { padding: 12px 16px; } }
`;

const TODO_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Tasks</title>
  <link rel="stylesheet" href="style.css" />
</head>
<body>
  <main class="app">
    <section class="card">
      <header class="head">
        <h1>Tasks</h1>
        <p id="count">Nothing yet — add your first task.</p>
      </header>

      <form class="composer" id="form">
        <input id="input" autocomplete="off" placeholder="What needs doing?" aria-label="New task" />
        <button class="btn primary" type="submit">Add</button>
      </form>

      <div class="filters" role="tablist" aria-label="Filter tasks">
        <button class="active" data-filter="all" role="tab" aria-selected="true">All</button>
        <button data-filter="active" role="tab" aria-selected="false">Active</button>
        <button data-filter="done" role="tab" aria-selected="false">Done</button>
      </div>

      <ul class="list" id="list"></ul>
      <div class="empty" id="empty"><strong>All clear</strong>Add a task above and press Enter.</div>

      <footer class="foot">
        <span id="left">0 left</span>
        <button class="clear" id="clear">Clear completed</button>
      </footer>
    </section>
  </main>
  <script src="app.js"></script>
</body>
</html>
`;

const TODO_JS = `const KEY = 'tasks.v1';
const form = document.getElementById('form');
const input = document.getElementById('input');
const list = document.getElementById('list');
const empty = document.getElementById('empty');
const count = document.getElementById('count');
const left = document.getElementById('left');
const clear = document.getElementById('clear');

let filter = 'all';
let tasks = load();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (error) {
    return [];
  }
}
function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(tasks));
  } catch (error) {
    /* storage may be unavailable in a sandboxed preview */
  }
}

function visible() {
  if (filter === 'active') return tasks.filter((task) => !task.done);
  if (filter === 'done') return tasks.filter((task) => task.done);
  return tasks;
}

function render() {
  list.innerHTML = '';
  const rows = visible();
  empty.hidden = rows.length > 0;
  for (const task of rows) {
    const item = document.createElement('li');
    item.className = 'item' + (task.done ? ' done' : '');

    const check = document.createElement('button');
    check.className = 'check';
    check.type = 'button';
    check.setAttribute('aria-label', task.done ? 'Mark not done' : 'Mark done');
    check.textContent = '✓';
    check.addEventListener('click', () => toggle(task.id));

    const text = document.createElement('span');
    text.className = 'text';
    text.textContent = task.text;

    const del = document.createElement('button');
    del.className = 'del';
    del.type = 'button';
    del.setAttribute('aria-label', 'Delete task');
    del.textContent = '✕';
    del.addEventListener('click', () => remove(task.id));

    item.append(check, text, del);
    list.append(item);
  }

  const remaining = tasks.filter((task) => !task.done).length;
  left.textContent = remaining + ' left';
  count.textContent = tasks.length
    ? remaining + ' of ' + tasks.length + ' remaining'
    : 'Nothing yet — add your first task.';
}

function add(text) {
  const trimmed = text.trim();
  if (!trimmed) return;
  tasks.unshift({ id: String(Date.now()), text: trimmed, done: false });
  save();
  render();
}

function toggle(id) {
  tasks = tasks.map((task) => (task.id === id ? { ...task, done: !task.done } : task));
  save();
  render();
}

function remove(id) {
  tasks = tasks.filter((task) => task.id !== id);
  save();
  render();
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  add(input.value);
  input.value = '';
  input.focus();
});

for (const button of document.querySelectorAll('[data-filter]')) {
  button.addEventListener('click', () => {
    filter = button.dataset.filter;
    for (const other of document.querySelectorAll('[data-filter]')) {
      const active = other === button;
      other.classList.toggle('active', active);
      other.setAttribute('aria-selected', String(active));
    }
    render();
  });
}

clear.addEventListener('click', () => {
  tasks = tasks.filter((task) => !task.done);
  save();
  render();
});

render();
input.focus();
`;

/* ── docs ─────────────────────────────────────────────────────────────────── */

const DOCS_CSS = `
.top { position: sticky; top: 0; z-index: 20; border-bottom: 1px solid var(--line);
  background: color-mix(in srgb, var(--bg) 88%, transparent); backdrop-filter: blur(12px); }
.top-in { display: flex; align-items: center; gap: 18px; height: 60px; }
.brand { display: flex; align-items: center; gap: 10px; font-weight: 680; }
.brand-mark { width: 22px; height: 22px; border-radius: 6px; background: linear-gradient(135deg, var(--accent), var(--accent-2)); }
.top .search { margin-left: auto; display: flex; align-items: center; gap: 8px; height: 34px; padding: 0 12px;
  border: 1px solid var(--line); border-radius: 9px; background: var(--panel); color: var(--fg-3); }
.top .search input { border: 0; background: none; outline: none; width: 200px; font-size: 13.5px; }
@media (max-width: 700px) { .top .search { display: none; } }
.layout { display: grid; grid-template-columns: 232px minmax(0, 1fr) 200px; gap: 40px; max-width: 1180px; margin: 0 auto; padding: 32px 24px 80px; }
@media (max-width: 1080px) { .layout { grid-template-columns: 220px minmax(0, 1fr); } .toc { display: none; } }
@media (max-width: 800px) { .layout { grid-template-columns: minmax(0, 1fr); } .side { display: none; } }
.side nav { position: sticky; top: 92px; display: grid; gap: 2px; }
.side h4 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.07em; color: var(--fg-3); margin: 16px 0 6px; }
.side a { display: block; padding: 6px 10px; border-radius: 8px; font-size: 14px; color: var(--fg-2); }
.side a:hover { background: var(--raise); color: var(--fg); }
.side a.active { background: color-mix(in srgb, var(--accent) 13%, transparent); color: var(--fg); font-weight: 550; }
article { min-width: 0; max-width: 720px; }
article h1 { font-size: clamp(1.8rem, 3.6vw, 2.5rem); margin-bottom: 10px; }
article h2 { font-size: 1.3rem; margin: 38px 0 10px; scroll-margin-top: 80px; }
article h3 { font-size: 1.05rem; margin: 24px 0 8px; }
article p { color: var(--fg-2); margin: 10px 0; }
article ul { color: var(--fg-2); padding-left: 20px; }
article li { margin: 6px 0; }
.lead { font-size: 1.05rem; color: var(--fg-2); }
pre { background: var(--bg-2); border: 1px solid var(--line); border-radius: 12px; padding: 16px; overflow-x: auto; margin: 14px 0; }
code { font-family: var(--mono); font-size: 13px; }
p code, li code { background: var(--raise); padding: 1px 6px; border-radius: 5px; font-size: 12.5px; }
.note { display: flex; gap: 12px; padding: 14px 16px; border-radius: 12px; margin: 18px 0;
  border: 1px solid color-mix(in srgb, var(--accent) 34%, var(--line)); background: color-mix(in srgb, var(--accent) 8%, transparent); }
.note p { margin: 0; color: var(--fg); font-size: 14px; }
.next { display: flex; gap: 12px; margin-top: 44px; }
.next a { flex: 1; padding: 16px; border-radius: 12px; border: 1px solid var(--line); background: var(--panel); }
.next a:hover { border-color: var(--line-2); }
.next span { display: block; font-size: 12px; color: var(--fg-3); }
.next b { font-weight: 550; }
.toc nav { position: sticky; top: 92px; display: grid; gap: 6px; }
.toc h4 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.07em; color: var(--fg-3); margin: 0 0 4px; }
.toc a { font-size: 13px; color: var(--fg-3); }
.toc a:hover { color: var(--fg); }
`;

const DOCS_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Docs — Quickstart</title>
  <link rel="stylesheet" href="style.css" />
</head>
<body>
  <header class="top">
    <div class="wrap top-in">
      <a class="brand" href="#"><span class="brand-mark"></span> Nimbus Docs</a>
      <label class="search">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
        <input type="search" id="q" placeholder="Search docs…" aria-label="Search docs" />
      </label>
    </div>
  </header>

  <div class="layout">
    <aside class="side">
      <nav aria-label="Documentation">
        <h4>Getting started</h4>
        <a class="active" href="#">Quickstart</a>
        <a href="#">Install</a>
        <a href="#">Deploy</a>
        <h4>Guides</h4>
        <a href="#">Domains</a>
        <a href="#">Environment variables</a>
        <a href="#">Rollbacks</a>
        <h4>Reference</h4>
        <a href="#">CLI</a>
        <a href="#">API</a>
      </nav>
    </aside>

    <article id="article">
      <h1>Quickstart</h1>
      <p class="lead">Ship your first project in about two minutes. You need a repository and nothing else.</p>

      <h2 id="install">1. Install the CLI</h2>
      <p>The CLI is a single binary. It runs on macOS, Linux and Windows.</p>
      <pre><code>npm install -g nimbus-cli
nimbus login</code></pre>

      <h2 id="deploy">2. Deploy</h2>
      <p>Run the deploy command from your project root. Nimbus detects the framework and builds it.</p>
      <pre><code>nimbus deploy

✓ Build finished in 8.2s
✓ Deployed to https://my-app.nimbus.app</code></pre>
      <div class="note">
        <p><strong>Tip:</strong> every push to a branch that is not <code>main</code> creates a preview URL instead of overwriting production.</p>
      </div>

      <h2 id="domains">3. Add a domain</h2>
      <p>Point a CNAME at your project and Nimbus issues the certificate automatically.</p>
      <ul>
        <li>Add the domain in the dashboard</li>
        <li>Create the CNAME record it shows you</li>
        <li>Wait for propagation — usually under a minute</li>
      </ul>

      <h2 id="rollback">Rolling back</h2>
      <p>Every deploy is immutable. Restoring an earlier one is instant and does not rebuild.</p>
      <pre><code>nimbus rollback --to 42</code></pre>

      <div class="next">
        <a href="#"><span>Next</span><b>Environment variables →</b></a>
        <a href="#"><span>Reference</span><b>CLI commands →</b></a>
      </div>
    </article>

    <aside class="toc">
      <nav aria-label="On this page">
        <h4>On this page</h4>
        <a href="#install">Install the CLI</a>
        <a href="#deploy">Deploy</a>
        <a href="#domains">Add a domain</a>
        <a href="#rollback">Rolling back</a>
      </nav>
    </aside>
  </div>
  <script src="app.js"></script>
</body>
</html>
`;

const DOCS_JS = `// Scrollspy for the on-this-page list, plus a simple in-page filter.
const headings = [...document.querySelectorAll('article h2[id]')];
const tocLinks = [...document.querySelectorAll('.toc a')];

const spy = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      for (const link of tocLinks) {
        link.style.color = link.getAttribute('href') === '#' + entry.target.id ? 'var(--fg)' : '';
      }
    }
  },
  { rootMargin: '-72px 0px -75% 0px' }
);
for (const heading of headings) spy.observe(heading);

document.getElementById('q')?.addEventListener('input', (event) => {
  const term = event.target.value.trim().toLowerCase();
  for (const section of document.querySelectorAll('article h2')) {
    const match = !term || section.textContent.toLowerCase().includes(term);
    section.style.opacity = match ? '' : '0.25';
  }
});
`;

/* ── registry ─────────────────────────────────────────────────────────────── */

export const SCAFFOLDS = {
  landing: {
    name: 'Landing page',
    blurb: 'Sticky nav, gradient hero, feature grid, three-tier pricing, CTA and footer.',
    files: (o) => ({ 'index.html': title(LANDING_HTML, o), 'style.css': BASE + LANDING_CSS, 'app.js': LANDING_JS }),
  },
  dashboard: {
    name: 'Dashboard',
    blurb: 'Sidebar shell, four stat cards with canvas sparklines, a 30-day chart, activity and a searchable table.',
    files: () => ({ 'index.html': DASH_HTML, 'style.css': BASE + DASH_CSS, 'app.js': DASH_JS }),
  },
  todo: {
    name: 'Todo app',
    blurb: 'Add, complete, filter and clear tasks; persists in localStorage with an empty state.',
    files: () => ({ 'index.html': TODO_HTML, 'style.css': BASE + TODO_CSS, 'app.js': TODO_JS }),
  },
  docs: {
    name: 'Docs site',
    blurb: 'Three-column documentation layout with scrollspy, sticky sidebar and readable typography.',
    files: () => ({ 'index.html': DOCS_HTML, 'style.css': BASE + DOCS_CSS, 'app.js': DOCS_JS }),
  },
};

export const SCAFFOLD_IDS = Object.keys(SCAFFOLDS);

/** Apply the brand name to a template's markup, so the result is not generic. */
function title(html, { brand = 'Nimbus' } = {}) {
  const safe = String(brand || 'Nimbus').replace(/[<>&"]/g, '').slice(0, 40);
  return html.split('Nimbus').join(safe);
}

/**
 * Render a scaffold.
 *
 * @param {string} id
 * @param {{brand?: string}} [options]
 * @returns {{files: Record<string,string>, blurb: string, lines: number}}
 */
export function renderScaffold(id, options = {}) {
  const scaffold = SCAFFOLDS[id];
  if (!scaffold) throw new Error(`Unknown scaffold "${id}". Available: ${SCAFFOLD_IDS.join(', ')}`);
  const files = scaffold.files(options);
  const lines = Object.values(files).reduce((sum, text) => sum + text.split('\n').length, 0);
  return { files, blurb: scaffold.blurb, lines };
}
