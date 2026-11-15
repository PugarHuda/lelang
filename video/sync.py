# Playwright's video drifts from wall-clock time (about 2 s over 2 minutes). Find each highlight box in the footage
# (its orange border is drawn into the page), fit video_time = a + b * clock_time, and rewrite all times in video time.
#   python video/sync.py   (after scripts/record-demo-v2.mjs; reads/writes data/video-v2/events.json, copies to video/public)
import io, json, shutil, subprocess
from PIL import Image
EV, FOOT = 'data/video-v2/events.json', 'video/public/footage.mp4'
d = json.load(open(EV))
def frame(t):
    out = subprocess.run(['ffmpeg', '-loglevel', 'error', '-ss', f'{t:.3f}', '-i', FOOT, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', '-'], capture_output=True).stdout
    return Image.open(io.BytesIO(out)).convert('RGB')
def orange(im, b):
    s = im.width / d['viewport']['w']
    hits = 0
    for fx in (0.3, 0.5, 0.7):  # three points on the top border, so the cursor can't hide it
        r, g, bl = im.getpixel((int((b['x'] + b['w'] * fx) * s), int((b['y'] + 1) * s)))
        hits += r > 200 and 40 < g < 130 and bl < 70
    return hits >= 2
pts = []
for b in d['boxes']:
    if b['h'] <= 0 or b['w'] <= 0: continue
    t0 = b.get('tAbs')
    coarse = next((t0 + k / 4 for k in range(-4, 24) if orange(frame(t0 + k / 4), b)), None)
    if coarse is None: print('not found', b['label']); continue
    fine = next(t for t in [coarse - 0.25 + k / 30 for k in range(9)] if orange(frame(t), b))
    b['tVideo'] = round(fine, 3); pts.append((t0, fine))
n = len(pts); mx = sum(p[0] for p in pts) / n; my = sum(p[1] for p in pts) / n
bslope = sum((x - mx) * (y - my) for x, y in pts) / sum((x - mx) ** 2 for x, _ in pts); a = my - bslope * mx
print(f'video = {a:.3f} + {bslope:.5f} * clock, residuals', [round(y - (a + bslope * x), 2) for x, y in pts])
v = lambda t: a + bslope * t
for s in d['scenes']: s['start'], s['end'] = round(v(s['start']), 3), round(v(s['end']), 3)
start = {s['id']: s['start'] for s in d['scenes']}
d['boxes'] = [b for b in d['boxes'] if b['h'] > 0 and b['w'] > 0]
for b in d['boxes']:
    b['tVideo'] = b.get('tVideo', round(v(b['tAbs']), 3))
    b['t'] = round(b['tVideo'] - start[b['scene']], 3)
d['synced'] = {'a': a, 'b': bslope}
json.dump(d, open(EV, 'w'), indent=1)
shutil.copy(EV, 'video/public/events.json')
