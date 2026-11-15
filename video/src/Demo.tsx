import React from 'react';
import { AbsoluteFill, Audio, OffthreadVideo, Sequence, interpolate, spring, staticFile, useCurrentFrame } from 'remotion';
import events from '../public/events.json';
import narration from '../public/narration.json';

export const FPS = 30;
const W = 1920, H = 1080;
type Box = { scene: string; t: number; x: number; y: number; w: number; h: number; hold: number; label: string };
type Word = { w: string; s: number; e: number };
const K = W / events.viewport.w; // CSS px -> frame px
const scenes = events.scenes.map((s: any, i: number, all: any[]) => {
  const from = all.slice(0, i).reduce((a, x) => a + Math.round((x.end - x.start) * FPS), 0);
  return { ...s, from, frames: Math.round((s.end - s.start) * FPS) };
});
export const totalFrames = scenes.reduce((a: number, s: any) => a + s.frames, 0);

// Subtitle chunks: the narrated words, with punctuation taken back from the script text.
const chunksFor = (id: string) => {
  const n = (narration as any[]).find((x) => x.id === id);
  const tokens: string[] = n.text.split(/\s+/);
  let j = 0;
  const words: Word[] = n.words.map((x: Word) => {
    const norm = (s: string) => s.toLowerCase().replace(/[^\w]/g, '');
    for (let k = j; k < Math.min(j + 3, tokens.length); k++) {
      if (norm(tokens[k]).startsWith(norm(x.w)) && norm(x.w)) { j = k + 1; return { ...x, w: tokens[k] }; }
    }
    return x;
  });
  const chunks: Word[][] = [];
  let c: Word[] = [];
  words.forEach((w, i) => {
    c.push(w);
    const next = words[i + 1];
    const brk = /[.,:?!]$/.test(w.w) && c.length >= 3;
    if (!next || c.length >= 8 || brk || (next.s - w.e > 0.35 && c.length >= 3)) { chunks.push(c); c = []; }
  });
  return chunks;
};

const zoomOf = (b: Box) => {
  const bx = b.x * K, by = b.y * K, bw = b.w * K, bh = b.h * K;
  let S = Math.min(0.78 * W / bw, 0.7 * H / bh, 1.8);
  if (S < 1.12) S = 1;
  const tx = Math.min(0, Math.max(W - S * W, W / 2 - S * (bx + bw / 2)));
  const ty = Math.min(0, Math.max(H - S * H, H * 0.45 - S * (by + bh / 2)));
  return { S, tx, ty, by, bh };
};

const Scene: React.FC<{ s: any }> = ({ s }) => {
  const frame = useCurrentFrame();
  const t = frame / FPS;
  const boxes = (events.boxes as Box[]).filter((b) => b.scene === s.id);
  let s1 = 1, tx = 0, ty = 0, active: { p: number; z: ReturnType<typeof zoomOf> } | null = null;
  for (const b of boxes) {
    const pin = spring({ frame: frame - Math.round(b.t * FPS), fps: FPS, config: { damping: 200 }, durationInFrames: 20 });
    const pout = spring({ frame: frame - Math.round((b.t + b.hold + 0.4) * FPS), fps: FPS, config: { damping: 200 }, durationInFrames: 20 });
    const p = pin - pout;
    if (p > 0.001 && (!active || p > active.p)) active = { p, z: zoomOf(b) };
  }
  if (active) {
    const { p, z } = active;
    s1 = 1 + (z.S - 1) * p; tx = z.tx * p; ty = z.ty * p;
  }
  const chunks = chunksFor(s.id);
  const chunk = chunks.find((c, i) => t >= c[0].s - 0.05 && t < (chunks[i + 1]?.[0].s ?? c[c.length - 1].e + 0.8));
  const boxBottom = active && active.p > 0.3 ? ty + s1 * (active.z.by + active.z.bh) : 0;
  const boxTop = active && active.p > 0.3 ? ty + s1 * active.z.by : H;
  const top = boxBottom > H * 0.8 && boxTop > H * 0.3;
  return (
    <AbsoluteFill style={{ backgroundColor: '#111' }}>
      <AbsoluteFill style={{ transform: `translate(${tx}px, ${ty}px) scale(${s1})`, transformOrigin: '0 0' }}>
        <OffthreadVideo src={staticFile("footage.mp4")} startFrom={Math.round(s.start * FPS)} muted style={{ width: W, height: H }} />
      </AbsoluteFill>
      <Audio src={staticFile(`${s.id}.mp3`)} />
      {chunk ? (
        <div style={{ position: 'absolute', left: 0, right: 0, [top ? 'top' : 'bottom']: 56, display: 'flex', justifyContent: 'center' }}>
          <div style={{ maxWidth: 1500, padding: '16px 30px', background: 'rgba(12,12,14,.86)', borderRadius: 16, font: '600 46px/1.3 "Segoe UI", system-ui, sans-serif', textAlign: 'center', boxShadow: '0 10px 40px rgba(0,0,0,.4)' }}>
            {chunk.map((w, i) => (
              <span key={i} style={{ color: t >= w.s && t < w.e + 0.05 ? '#ffb02e' : t >= w.s ? '#fff' : 'rgba(255,255,255,.55)' }}>{w.w}{i < chunk.length - 1 ? ' ' : ''}</span>
            ))}
          </div>
        </div>
      ) : null}
      {s.id === 'intro' ? <Title frame={frame} /> : null}
      {s.id === 'close' ? <EndCard frame={frame} /> : null}
    </AbsoluteFill>
  );
};

const Title: React.FC<{ frame: number }> = ({ frame }) => {
  const o = interpolate(frame, [0, 12, 120, 140], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <div style={{ position: 'absolute', left: 56, top: 48, opacity: o, padding: '18px 28px', background: 'rgba(12,12,14,.88)', borderRadius: 16, color: '#fff', font: '700 54px/1.1 "Segoe UI", system-ui, sans-serif' }}>
      Lelang<div style={{ font: '500 28px/1.4 "Segoe UI", system-ui, sans-serif', color: '#ddd' }}>Sealed-bid tenders run by AI agents · escrow on Kite testnet</div>
    </div>
  );
};

const EndCard: React.FC<{ frame: number }> = ({ frame }) => {
  const o = interpolate(frame, [0, 15], [0, 1], { extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill style={{ background: `rgba(10,10,12,${0.82 * o})`, alignItems: 'center', justifyContent: 'center', color: '#fff', textAlign: 'center' }}>
      <div style={{ opacity: o, font: '700 92px/1.15 "Segoe UI", system-ui, sans-serif' }}>Attackers fund the defence.</div>
      <div style={{ opacity: o, marginTop: 36, font: '600 52px/1.2 "Segoe UI", system-ui, sans-serif', color: '#ffb02e' }}>lelang-ten.vercel.app</div>
    </AbsoluteFill>
  );
};

export const Demo: React.FC = () => (
  <AbsoluteFill style={{ backgroundColor: '#111' }}>
    {scenes.map((s: any) => (
      <Sequence key={s.id} from={s.from} durationInFrames={s.frames}>
        <Scene s={s} />
      </Sequence>
    ))}
  </AbsoluteFill>
);
