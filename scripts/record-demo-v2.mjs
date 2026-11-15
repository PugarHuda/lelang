// Records the footage for the v2 demo (public/demo-v2.mp4, edited in video/ with Remotion).
// Real clicks on the real pages; every in-browser check hits Kite testnet live.
// Needs the narration first (data/video-v2/tts.py -> video/public/*.mp3 + narration.json): each scene lasts as long as its clip.
//   node scripts/record-demo-v2.mjs   -> video/public/footage.webm + data/video-v2/events.json (+ a copy in video/public)
import { chromium } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, rmSync, mkdirSync, renameSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';

const PORT = 4181, BASE = `http://localhost:${PORT}`;
const W = 1280, H = 720, SCALE = 1; // ponytail: deviceScaleFactor>1 crops Playwright's video, so record 1:1 and upscale in Remotion
const narration = JSON.parse(readFileSync('video/public/narration.json', 'utf8'));
const clip = Object.fromEntries(narration.map((s) => [s.id, {
  dur: Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', `video/public/${s.id}.mp3`]).toString()),
  words: s.words,
}]));

const server = spawn(process.execPath, ['scripts/serve-static.js'], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1500));
const raw = 'data/video-v2/raw';
rmSync(raw, { recursive: true, force: true });
mkdirSync(raw, { recursive: true });

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined });
const ctx = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: raw, size: { width: W * SCALE, height: H * SCALE } }, colorScheme: 'light' });
// Visible cursor: a dot that follows real mouse events (added via CDP, so the page CSP doesn't apply).
await ctx.addInitScript(() => {
  const add = () => {
    const d = document.createElement('div');
    d.id = '__cursor';
    Object.assign(d.style, { position: 'fixed', left: '0', top: '0', width: '22px', height: '22px', margin: '-11px 0 0 -11px', borderRadius: '50%', background: 'rgba(255,72,0,.85)', border: '3px solid #fff', boxShadow: '0 2px 10px rgba(0,0,0,.45)', zIndex: 2147483647, pointerEvents: 'none', transition: 'transform .12s', transform: `translate(${window.__mx ?? -50}px, ${window.__my ?? -50}px)` });
    document.documentElement.appendChild(d);
    addEventListener('mousemove', (e) => { d.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`; }, true);
    addEventListener('mousedown', () => { d.style.background = 'rgba(255,200,0,.95)'; }, true);
    addEventListener('mouseup', () => { d.style.background = 'rgba(255,72,0,.85)'; }, true);
  };
  if (document.documentElement) add(); else addEventListener('DOMContentLoaded', add);
});
const page = await ctx.newPage();
const T0 = Date.now(); // the recording starts with the page
const now = () => (Date.now() - T0) / 1000;
const scenes = [], boxes = [];
let mouse = { x: W / 2, y: H / 2 }, cur = null;

const wait = (ms) => page.waitForTimeout(ms);
const go = async (path, ready) => {
  await page.goto(`${BASE}/${path}`);
  // a cold first load sometimes misses the static fallback; one reload fixes it
  if (ready) await ready().catch(async () => { await page.reload(); await ready().catch(() => {}); });
  await page.mouse.move(mouse.x, mouse.y);
};
// time (s, scene-relative) of the first narrated word starting with `w`
const at = (w) => {
  const hit = clip[cur.id].words.find((x) => x.w.toLowerCase().replace(/[^\w-]/g, '').startsWith(w.toLowerCase()));
  if (!hit) throw new Error(`word ${w} not in ${cur.id}`);
  return hit.s;
};
const until = async (sec) => { const ms = (cur.start + sec - now()) * 1000; if (ms > 0) await wait(ms); };
const scene = async (id, fn) => {
  cur = { id, start: now(), dur: clip[id].dur };
  await fn().catch((e) => console.warn(id, e.message));
  await until(cur.dur + 0.5);
  cur.end = now();
  scenes.push(cur);
  console.log(id, cur.start.toFixed(1), cur.end.toFixed(1));
};
const travel = async (x, y) => { await page.mouse.move(x, y, { steps: 28 }); mouse = { x, y }; };
// Scroll the element into the middle, then outline it exactly where it sits in this frame, and log the box.
const highlight = async (loc, label, hold = 2.6, { click = false, pad = 6 } = {}) => {
  const el = loc.first();
  await el.waitFor({ timeout: 15_000 });
  await el.evaluate((e) => e.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  await wait(900);
  // pages with their own scroll handling can swallow the smooth scroll: snap if it is still off screen
  if (await el.evaluate((e, h) => { const b = e.getBoundingClientRect(); return b.bottom < 0 || b.top > h; }, H)) {
    await el.scrollIntoViewIfNeeded();
    await wait(400);
  }
  // long smooth scrolls outlast the wait: re-measure until the element has stopped moving
  const rect = () => el.evaluate((e) => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; });
  let r = await rect();
  for (let i = 0, same = 0; i < 40 && same < 3; i++) {
    await wait(100);
    const n = await rect();
    same = JSON.stringify(n) === JSON.stringify(r) ? same + 1 : 0;
    r = n;
  }
  const box = { x: Math.max(4, r.x - pad), y: Math.max(4, r.y - pad) };
  box.w = Math.min(W - 4, r.x + r.w + pad) - box.x;
  box.h = Math.min(H - 4, r.y + r.h + pad) - box.y;
  await page.evaluate(({ x, y, w, h }) => {
    const d = document.createElement('div');
    d.className = '__hl';
    Object.assign(d.style, { position: 'fixed', left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px`, border: '3px solid #ff4800', borderRadius: '10px', boxShadow: '0 0 0 4000px rgba(10,10,10,.18)', zIndex: 2147483646, pointerEvents: 'none' });
    document.documentElement.appendChild(d);
  }, box);
  boxes.push({ scene: cur.id, t: +(now() - cur.start).toFixed(3), tAbs: +now().toFixed(3), ...box, hold, label });
  await travel(Math.min(r.x + r.w / 2, box.x + box.w - 20), Math.min(r.y + Math.min(r.h / 2, 40), box.y + box.h - 10));
  await wait(hold * 1000);
  // click last, then drop the box at once: a click can re-layout the page (Verify collapses the result) and the box would float
  if (click) await page.mouse.click(mouse.x, mouse.y);
  await page.evaluate(() => document.querySelectorAll('.__hl').forEach((d) => d.remove()));
};

try {
  await go('index.html?t=rfq-mwdt4xm3', () => page.waitForFunction(() => window.__lastRfq, null, { timeout: 15_000 }));
  await scene('intro', async () => {
    await until(at('hide') - 0.6);
    await highlight(page.locator('.bid:has-text("Bond slashed")'), 'Bid E hid an instruction for the AI', 4);
    await until(at('escrow') - 0.6);
    await highlight(page.locator('#proof'), 'Checked against Kite by your browser', 4.5);
  });

  await go('slash.html?t=rfq-mwdt4xm3&b=Bid%20E', () => page.locator('#result').filter({ hasText: /match|Couldn't reach/ }).waitFor({ timeout: 45_000 }));
  await scene('slash', async () => {
    await until(at('highlighted') - 0.8);
    await highlight(page.locator('mark'), 'The hidden instruction', 3.5);
    await until(at('Verify') - 1.2);
    await highlight(page.locator('#go'), 'Verify against Kite testnet', 1.2, { click: true });
    await page.locator('#result').filter({ hasText: /match|Couldn't reach/ }).waitFor({ timeout: 45_000 }).catch(() => {});
    await until(at('Every') - 1.2);
    await highlight(page.locator('#result'), 'Every check matches Kite', 5);
  });

  await go('pool.html', () => page.locator('#slashes').filter({ hasNotText: 'Reading' }).waitFor({ timeout: 45_000 }));
  await scene('pool', async () => {
    await until(at('challenge') - 0.8);
    await highlight(page.locator('#slashes'), 'Slashes on escrow V4, status read live', 4.5);
    await until(at('bounty') - 0.8);
    await highlight(page.locator('#pool'), 'The bounty pool', 3.5);
    await until(at('reads') - 0.6);
    await highlight(page.locator('#poolNote'), 'Read live from the escrow', 3);
  });

  await go('attacks.html', () => page.waitForFunction(() => window.__attacksDone, null, { timeout: 30_000 }));
  await scene('attacks', async () => {
    await until(at('Forty') - 0.6);
    await highlight(page.locator('#view > .card').first(), '40/40 caught, 0 false alarms', 4.5);
    await until(at('two') - 1);
    await highlight(page.locator('.card:has(b:has-text("WOULD HAVE WON: not flagged"))'), 'Two prices for one term: would have won', 4.5);
    await until(at('after') - 0.8);
    await highlight(page.locator('h2:has-text("after the ambiguity check")'), 'After the fix: 0 of 6', 3);
    await until(at('Anyone') - 0.8);
    await highlight(page.locator('h2:has-text("Break Lelang")'), 'Break Lelang: live, paid challenge', 3.5);
  });

  await go('index.html', () => page.waitForFunction(() => window.__lastRfq, null, { timeout: 30_000 }));
  await scene('reppo', async () => {
    await until(at('Reppo') - 0.8);
    await highlight(page.locator('h2:has-text("Independent audit") + .card'), 'Reppo audit gates settlement', 4.5);
    await go('landing.html');
    await until(at('publish') - 1.2);
    await highlight(page.locator('#next'), 'Next miss', 0.6, { click: true }); // the misses are a carousel; the Reppo one is third
    await page.mouse.click(mouse.x, mouse.y);
    await wait(900);
    await until(at('Rules') - 0.6);
    await highlight(page.locator('#fan article:has-text("Rules learned from Reppo")'), 'A published negative result', 4.5);
  });

  if (existsSync('public/win.html')) {
    await go('win.html?t=rfq-mwdt4xm3', () => page.locator('#verdict').filter({ hasText: /✓|✗|Not|Couldn/ }).waitFor({ timeout: 45_000 }));
    await scene('win', async () => {
      await until(at('certificate') - 0.8);
      await highlight(page.locator('#verdict'), 'Clean win, verified', 2.5);
      await until(at('checked') - 1.2);
      await highlight(page.locator('#checks'), 'Checked in your browser', 4);
    });
  }

  await go('stats.html', () => page.waitForFunction(() => window.__statsDone, null, { timeout: 60_000 }));
  await scene('stats', async () => {
    await until(at('tenders') - 0.6);
    await highlight(page.locator('#tiles'), 'Counted from escrow events on Kite', 5);
  });

  await go('landing.html');
  await scene('close', async () => { await travel(W / 2, H * 0.4); });
} finally {
  await page.close();
  await ctx.close();
  await browser.close();
  server.kill();
}
const webm = readdirSync(raw).find((f) => f.endsWith('.webm'));
renameSync(`${raw}/${webm}`, 'video/public/footage.webm');
// constant 30 fps H.264 with short GOPs so Remotion can seek to every scene start
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', 'video/public/footage.webm', '-r', '30', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-g', '15', '-pix_fmt', 'yuv420p', 'video/public/footage.mp4']);
const events = { viewport: { w: W, h: H }, scale: SCALE, scenes, boxes };
writeFileSync('data/video-v2/events.json', JSON.stringify(events, null, 1));
copyFileSync('data/video-v2/events.json', 'video/public/events.json');
console.log('video/public/footage.mp4', scenes.length, 'scenes', boxes.length, 'boxes');
