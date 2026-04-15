/**
 * Static brand assets — served from the root domain under `/assets/*`.
 *
 * Kept as literal strings so Workers can serve them without a build step or
 * static-asset binding. Brand language mirrors octopus-ui (forest/turquoise
 * palette, Fraunces/Inter/JetBrains Mono).
 */

import { Hono } from "hono";
import type { Env } from "../env.js";

export const assetsApp = new Hono<{ Bindings: Env }>();

assetsApp.get("/styles.css", (c) => {
  return new Response(STYLES, {
    status: 200,
    headers: {
      "Content-Type": "text/css; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
});

assetsApp.get("/favicon.svg", (c) => {
  return new Response(FAVICON, {
    status: 200,
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": "public, max-age=86400",
    },
  });
});

const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<circle cx="32" cy="26" r="14" fill="#7AB09D"/>
<path d="M18 30 Q12 44 10 54 M26 34 Q22 48 20 58 M32 36 Q32 50 32 60 M38 34 Q42 48 44 58 M46 30 Q52 44 54 54" stroke="#8CCFCE" stroke-width="2.5" stroke-linecap="round" fill="none"/>
</svg>`;

const STYLES = `
:root {
  --bg: #0f1715;
  --bg-raised: #192823;
  --bg-elev: #1e3029;
  --bg-hover: #213630;
  --forest: #7AB09D;
  --forest-dim: rgba(122, 176, 157, 0.14);
  --turquoise: #8CCFCE;
  --turquoise-dim: rgba(140, 207, 206, 0.14);
  --border: rgba(122, 176, 157, 0.15);
  --border-strong: rgba(122, 176, 157, 0.28);
  --text: #E8E5E1;
  --text-dim: #A09B95;
  --text-muted: #7a7570;
  --amber: #D4A373;
  --err: #c88a7d;
  --mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  --ui: "Inter var", Inter, system-ui, -apple-system, "Segoe UI", sans-serif;
  --display: "Fraunces", Georgia, serif;
  --radius: 12px;
  --radius-sm: 7px;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text); font-family: var(--ui); font-size: 14px; line-height: 1.5; -webkit-font-smoothing: antialiased; }
body { min-height: 100vh; position: relative; overflow-x: hidden; }
body::before {
  content: ""; position: fixed; inset: -25%; pointer-events: none; z-index: 0;
  background:
    radial-gradient(ellipse 55% 45% at 80% 15%, rgba(140, 207, 206, 0.07), transparent 60%),
    radial-gradient(ellipse 50% 40% at 15% 90%, rgba(122, 176, 157, 0.05), transparent 60%);
  animation: silkDrift 80s ease-in-out infinite alternate;
}
@keyframes silkDrift {
  0% { transform: translate3d(0, 0, 0) scale(1); }
  100% { transform: translate3d(-3%, 2%, 0) scale(1.08); }
}
body > * { position: relative; z-index: 1; }
a { color: var(--turquoise); text-decoration: none; }
a:hover { text-decoration: underline; }
code, .mono { font-family: var(--mono); font-size: 12.5px; }
code { background: var(--bg-raised); padding: 1px 6px; border-radius: 4px; border: 1px solid var(--border); }

/* Layout */
.topnav { display: flex; align-items: center; gap: 1rem; padding: 0.9rem 1.5rem; border-bottom: 1px solid var(--border); background: rgba(15, 23, 21, 0.85); backdrop-filter: blur(8px); position: sticky; top: 0; z-index: 10; }
.topnav .brand { font-family: var(--display); font-style: italic; font-weight: 500; color: var(--forest); font-size: 20px; letter-spacing: -0.01em; }
.topnav .host { font-family: var(--mono); color: var(--text-dim); font-size: 12.5px; }
.topnav .spacer { flex: 1; }
.topnav .email { color: var(--text-dim); font-size: 12.5px; }
.container { max-width: 960px; margin: 0 auto; padding: 2rem 1.5rem 4rem; }
h1, h2, h3 { font-family: var(--display); font-weight: 500; color: var(--text); letter-spacing: -0.015em; margin: 0; }
h1 { font-size: 32px; font-style: italic; color: var(--forest); }
h2 { font-size: 22px; margin-bottom: 0.8rem; }
h3 { font-size: 16px; margin-bottom: 0.6rem; }

/* Hero */
.hero { margin-bottom: 2.2rem; }
.hero p { color: var(--text-dim); max-width: 620px; margin: 0.4rem 0 0; }

/* Section */
section { margin: 2rem 0; }
section header { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 0.9rem; gap: 1rem; }
section header h2 { margin: 0; }

/* Card */
.card { background: var(--bg-raised); border: 1px solid var(--border); border-radius: var(--radius); padding: 1.1rem 1.2rem; position: relative; }
.card:hover { border-color: var(--border-strong); background: var(--bg-elev); }
.card h3 { margin-bottom: 0.3rem; color: var(--forest); }
.card .slug { font-family: var(--mono); color: var(--text-dim); font-size: 12px; }
.card .meta { color: var(--text-muted); font-size: 12.5px; margin-top: 0.7rem; }
.card .actions { margin-top: 1rem; display: flex; gap: 0.5rem; flex-wrap: wrap; }

.grid { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); }

/* Buttons */
.btn { display: inline-flex; align-items: center; gap: 0.4rem; padding: 0.45rem 0.9rem; border-radius: var(--radius-sm); border: 1px solid var(--border-strong); background: transparent; color: var(--text); font: inherit; font-size: 13px; cursor: pointer; text-decoration: none; transition: background 0.15s, border-color 0.15s; }
.btn:hover { background: var(--bg-hover); border-color: var(--forest); text-decoration: none; }
.btn-primary { background: var(--forest); color: var(--bg); border-color: var(--forest); font-weight: 500; }
.btn-primary:hover { background: var(--turquoise); border-color: var(--turquoise); }
.btn-danger { border-color: var(--err); color: var(--err); }
.btn-danger:hover { background: rgba(200, 138, 125, 0.12); border-color: var(--err); }
.btn-ghost { border-color: transparent; color: var(--text-dim); }
.btn-ghost:hover { background: var(--bg-hover); color: var(--text); }

/* Forms */
input[type="text"], input:not([type]), input[type="email"] { background: var(--bg); border: 1px solid var(--border-strong); color: var(--text); padding: 0.5rem 0.7rem; border-radius: var(--radius-sm); font: inherit; font-size: 14px; width: 100%; }
input:focus { outline: none; border-color: var(--forest); }
label { display: block; color: var(--text-dim); font-size: 12.5px; margin-bottom: 0.3rem; }
.field { margin-bottom: 1rem; }
.field-row { display: flex; gap: 0.6rem; align-items: flex-end; }
.field-row input { flex: 1; }

/* Pills & badges */
.pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11.5px; border: 1px solid var(--border-strong); color: var(--text-dim); background: var(--forest-dim); }
.pill-turquoise { background: var(--turquoise-dim); border-color: var(--turquoise); color: var(--turquoise); }
.pill-amber { background: rgba(212, 163, 115, 0.14); border-color: var(--amber); color: var(--amber); }

/* Tables */
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 0.55rem 0.6rem; border-bottom: 1px solid var(--border); font-size: 13.5px; }
th { color: var(--text-muted); font-weight: 500; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; }
tr:last-child td { border-bottom: none; }

/* Banners */
.banner { border: 1px solid var(--forest); background: var(--forest-dim); border-radius: var(--radius); padding: 1rem 1.2rem; margin-bottom: 1.5rem; }
.banner h2 { color: var(--forest); margin-bottom: 0.3rem; font-size: 18px; }
.banner-warn { border-color: var(--amber); background: rgba(212, 163, 115, 0.08); }
.banner-warn h2 { color: var(--amber); }
.token-reveal { font-family: var(--mono); word-break: break-all; background: var(--bg); padding: 0.6rem 0.8rem; border-radius: var(--radius-sm); border: 1px solid var(--border-strong); margin: 0.6rem 0; font-size: 12.5px; color: var(--turquoise); }

/* Empty */
.empty { text-align: center; padding: 2.5rem 1rem; color: var(--text-dim); border: 1px dashed var(--border-strong); border-radius: var(--radius); }
.empty p { margin: 0.4rem 0; }

/* Modal (CSS-only via :target) */
.modal { position: fixed; inset: 0; background: rgba(0,0,0,0.6); display: none; align-items: center; justify-content: center; z-index: 50; padding: 1rem; }
.modal:target { display: flex; }
.modal-body { background: var(--bg-raised); border: 1px solid var(--border-strong); border-radius: var(--radius); padding: 1.5rem; max-width: 440px; width: 100%; }
.modal-body h3 { margin-bottom: 0.8rem; }

/* Onboarding */
.onboard { max-width: 520px; margin: 4rem auto; padding: 2rem; }
.onboard h1 { text-align: center; margin-bottom: 0.5rem; }
.onboard .lead { text-align: center; color: var(--text-dim); margin-bottom: 2.5rem; }
.hostname-preview { font-family: var(--mono); color: var(--turquoise); text-align: center; margin: 0.6rem 0 1.2rem; font-size: 15px; min-height: 1.4em; }
.hostname-preview.err { color: var(--err); }
.hostname-preview.ok::after { content: " ✓"; color: var(--forest); }

/* Danger zone */
.danger-zone { border: 1px solid var(--err); border-radius: var(--radius); padding: 1.1rem 1.2rem; margin-top: 2rem; }
.danger-zone h3 { color: var(--err); }
.danger-zone p { color: var(--text-dim); font-size: 13px; }

/* Footer */
footer { margin-top: 4rem; padding: 2rem 1.5rem; color: var(--text-muted); font-size: 12.5px; text-align: center; border-top: 1px solid var(--border); }
`;
