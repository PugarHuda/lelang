// Social preview images: public/og.png for the site, and one "slash receipt" per slashed bid in the published tenders
// (public/r/<tender>-<bid>.png) with a tiny share page (public/r/<tender>-<bid>.html) whose Open Graph tags point at it,
// because crawlers don't run slash.html's JS. Rerun after publishing tenders: node scripts/og.mjs (PW_CHANNEL=chrome locally).
import { chromium } from '@playwright/test';
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SITE = 'https://lelang-ten.vercel.app';
const pub = new URL('../public/', import.meta.url);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const short = (h) => (h ? `${h.slice(0, 10)}…${h.slice(-8)}` : '');

const frame = (inner) => `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Inter+Tight:wght@400;500;600&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>*{box-sizing:border-box}body{margin:0;width:1200px;height:630px;background:#ebedf0;font-family:"Inter Tight",sans-serif;color:#0c0d10;padding:24px}
.sheet{background:#fff;border-radius:32px;height:100%;padding:56px 64px;position:relative;overflow:hidden}
.mono{font-family:"JetBrains Mono",monospace;font-variant-ligatures:none}.logo{display:flex;align-items:center;gap:10px;font-weight:600;font-size:26px;letter-spacing:-.03em}
.logo i{width:30px;height:30px;border-radius:10px;background:radial-gradient(circle,#fff 0 5px,transparent 5.5px),linear-gradient(155deg,#a993ff,#7b5cff 50%,#5b3fe0)}
.tile{position:absolute;border-radius:24px;box-shadow:inset 0 2px 0 rgba(255,255,255,.6),inset 0 -5px 10px rgba(0,0,0,.18),0 20px 34px -14px var(--c);background:linear-gradient(155deg,color-mix(in srgb,var(--c) 55%,#fff),var(--c) 48%,color-mix(in srgb,var(--c) 78%,#000))}
.stamp{display:inline-block;font-variant-ligatures:none;font:600 18px "JetBrains Mono",monospace;letter-spacing:.08em;text-transform:uppercase;border:2.5px solid;border-radius:10px;padding:10px 14px}
</style></head><body><div class="sheet">${inner}</div></body></html>`;

const site = frame(`<div class="logo"><i></i>Lelang</div>
<div class="tile" style="--c:#7b5cff;width:150px;height:150px;right:120px;top:70px"></div>
<div class="tile" style="--c:#f2463a;width:90px;height:90px;right:330px;top:40px"></div>
<div class="tile" style="--c:#f5b800;width:80px;height:80px;right:60px;top:270px"></div>
<div class="tile" style="--c:#1fb6ec;width:96px;height:96px;right:300px;top:230px"></div>
<h1 style="font-weight:500;font-size:84px;line-height:.98;letter-spacing:-.05em;margin:90px 0 0;max-width:720px">Sealed-bid tenders for AI agents</h1>
<p style="font-size:26px;color:#5b616c;max-width:760px;margin:24px 0 0;line-height:1.35">A bid that hides instructions for the AI evaluator loses its bond, and the quote that proves it is hashed into Kite testnet.</p>
<p class="mono" style="position:absolute;bottom:46px;left:64px;margin:0;font-size:18px;color:#8b9099">lelang-ten.vercel.app · escrow on Kite testnet · SERV · Dolphin · Reppo</p>`);

const receipt = (rfq, b, settleTx) => {
  const up = b.appeal?.outcome !== 'overturned';
  const quote = String(b.evidence).replace(/\s+/g, ' ').slice(0, 230);
  return frame(`<div style="display:flex;justify-content:space-between;align-items:center"><div class="logo"><i></i>Lelang</div><span class="mono" style="font-size:18px;color:#8b9099">slash receipt · escrow ${esc(short(rfq.escrow))} · tender #${esc(rfq.chainId)}</span></div>
<p style="font-size:24px;color:#5b616c;margin:34px 0 0">${esc(rfq.title)}</p>
<h1 style="font-weight:500;font-size:64px;letter-spacing:-.045em;margin:6px 0 18px">${esc(b.label)}</h1>
<span class="stamp" style="color:${up ? '#e0382c;background:#fff0ee' : '#17824f;background:#e5f6ed'}">${up ? 'Disqualified · bond slashed' : 'Slash overturned on appeal · bond refunded'}</span>
<div class="mono" style="margin-top:26px;background:#fff0ee;color:#c32a1f;border-radius:16px;padding:18px 22px;font-size:19px;line-height:1.5">“${esc(quote)}${quote.length >= 230 ? '…' : ''}”</div>
<p class="mono" style="position:absolute;bottom:44px;left:64px;right:64px;margin:0;font-size:17px;color:#8b9099;display:flex;justify-content:space-between"><span>evidence ${esc(short(b.evidenceHash))}</span><span>settle ${esc(short(settleTx?.split('/').pop()))}</span><span>verify in your browser →</span></p>`);
};

const share = (title, desc, img, target) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}"><meta property="og:type" content="article"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${SITE}/${img}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta name="twitter:card" content="summary_large_image">
<meta http-equiv="refresh" content="0; url=${esc(target)}"></head><body><p><a href="${esc(target)}">Open the proof page</a></p></body></html>`;

const browser = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {});
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
const shot = async (html, file) => { await page.setContent(html, { waitUntil: 'networkidle' }); await page.screenshot({ path: fileURLToPath(new URL(file, pub)) }); };

await shot(site, 'og.png');
mkdirSync(new URL('r/', pub), { recursive: true });
const made = [];
for (const f of readdirSync(new URL('tenders/', pub)).filter((n) => /^rfq-[\w-]+\.json$/.test(n) && !n.endsWith('.ocds.json'))) {
  const rfq = JSON.parse(readFileSync(new URL(`tenders/${f}`, pub), 'utf8'));
  const settleTx = (rfq.settlement ?? []).find((s) => s.tx)?.tx;
  for (const b of Object.values(rfq.bids ?? {})) {
    if (!b.slash || !b.evidence) continue;
    const slug = `${rfq.id}-${b.label.replace(/\s+/g, '').toLowerCase()}`;
    await shot(receipt(rfq, b, settleTx), `r/${slug}.png`);
    const up = b.appeal?.outcome !== 'overturned';
    writeFileSync(new URL(`r/${slug}.html`, pub), share(`${b.label} ${up ? 'slashed' : 'slash overturned'}: ${rfq.title}`, up ? 'Caught hiding instructions for the AI evaluator. The quote is hashed into Kite testnet: verify it in your browser.' : 'Slashed, appealed and overturned by the approvers; the bond was refunded. Check every step against Kite testnet.', `r/${slug}.png`, `../slash.html?t=${rfq.id}&b=${encodeURIComponent(b.label)}`));
    made.push(slug);
  }
}
await browser.close();
console.log(`og.png + ${made.length} receipts: ${made.join(', ')}`);
