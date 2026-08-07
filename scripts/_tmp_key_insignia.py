"""One-shot: chroma-key squadron insignia to transparent PNG (exactly 2 speed lines)."""
from pathlib import Path

import numpy as np
from PIL import Image

src = Path(
    r"C:\Users\sadeg\.grok\sessions\C%3A%5CUsers%5Csadeg%5Cscrapstorm-league-source"
    r"\019fdb66-2a1e-78c2-bba3-f933ae5c5fca\images\3.jpg"
)
out_session = Path(
    r"C:\Users\sadeg\.grok\sessions\C%3A%5CUsers%5Csadeg%5Cscrapstorm-league-source"
    r"\019fdb66-2a1e-78c2-bba3-f933ae5c5fca\images\squadron-insignia.png"
)
out_assets = Path(
    r"C:\Users\sadeg\scrapstorm-league-source\public\assets\ui\insignia\squadron-insignia.png"
)

im = Image.open(src).convert("RGBA")
arr = np.array(im).astype(np.float32)
r, g, b = arr[:, :, 0], arr[:, :, 1], arr[:, :, 2]

# Soft green-screen key
green_dom = g - np.maximum(r, b)
g_ratio = g / (r + g + b + 1e-6)
key = np.clip((green_dom - 12.0) / 55.0, 0.0, 1.0)
key2 = np.clip((g_ratio - 0.42) / 0.18, 0.0, 1.0) * np.clip((g - 60) / 80, 0, 1)
key_strength = np.maximum(key, key2 * 0.85)

warm = np.clip((r - g) / 35.0, 0.0, 1.0)
steel = (
    np.clip(1.0 - np.abs(r - g) / 40.0, 0, 1)
    * np.clip(1.0 - np.abs(g - b) / 40.0, 0, 1)
    * np.clip(((r + g + b) / 3) / 80, 0, 1)
)
protect = np.maximum(warm, steel * 0.55 * (1.0 - np.clip(green_dom / 40, 0, 1)))
key_strength = key_strength * (1.0 - protect)

alpha = (1.0 - key_strength) * 255.0
spill = key_strength * 0.8
arr[:, :, 1] = g * (1.0 - spill) + np.minimum(r, b) * spill
partial = ((alpha > 20) & (alpha < 220)).astype(np.float32)
arr[:, :, 0] = np.clip(arr[:, :, 0] + partial * 8, 0, 255)
arr[:, :, 3] = alpha

h, w = alpha.shape
# Speed lines live in far-left region only (~first 28% of width)
line_w = int(w * 0.28)

# Find horizontal paint mass in far-left strip only (avoid arrow body)
strip = arr[:, :line_w]
is_paint = (
    (strip[:, :, 3] > 160)
    & (strip[:, :, 0] + 5 > strip[:, :, 1])
    & (strip[:, :, 0] > 70)
)
row_sum = is_paint.sum(axis=1).astype(np.float64)

# Smooth row mass slightly to stabilize peaks
kernel = np.ones(5) / 5
smooth = np.convolve(row_sum, kernel, mode="same")

# Local maxima as candidate line centers
peaks = []
for i in range(10, h - 10):
    if smooth[i] < 12:
        continue
    if smooth[i] >= smooth[i - 1] and smooth[i] >= smooth[i + 1]:
        if smooth[i] >= smooth[i - 3] and smooth[i] >= smooth[i + 3]:
            peaks.append((i, smooth[i]))

# Merge nearby peaks
merged = []
for i, m in sorted(peaks, key=lambda t: -t[1]):
    if any(abs(i - j) < 30 for j, _ in merged):
        continue
    merged.append((i, m))
merged = sorted(merged, key=lambda t: t[0])
print("peaks", merged)

# Expect 3 line peaks; drop the middle by y
if len(merged) >= 3:
    mid_y = merged[len(merged) // 2][0]
    # Clear a thin band around mid peak, only in far-left strip
    y0, y1 = max(0, mid_y - 14), min(h - 1, mid_y + 14)
    arr[y0 : y1 + 1, :line_w, 3] = 0
    print(f"removed middle line around y={mid_y} rows {y0}-{y1}")
elif len(merged) == 2:
    print("already 2 peaks; no middle to remove")
else:
    # Measured middle band on this source
    arr[485:530, :line_w, 3] = 0
    print("force cleared middle band 485-530")

# Drop leftover green-dominant flecks
r2, g2, b2, a2 = arr[:, :, 0], arr[:, :, 1], arr[:, :, 2], arr[:, :, 3]
still = (a2 > 100) & (g2 > r2 + 20) & (g2 > b2 + 20) & (g2 > 100)
arr[still, 3] = 0

out = Image.fromarray(arr.astype(np.uint8), "RGBA")

alpha_final = arr[:, :, 3]
ys, xs = np.where(alpha_final > 16)
pad = 40
x0 = max(0, int(xs.min()) - pad)
x1 = min(w, int(xs.max()) + pad + 1)
y0 = max(0, int(ys.min()) - pad)
y1 = min(h, int(ys.max()) + pad + 1)
side = max(x1 - x0, y1 - y0)
cx = (x0 + x1) // 2
cy = (y0 + y1) // 2
x0 = max(0, cx - side // 2)
y0 = max(0, cy - side // 2)
x1 = min(w, x0 + side)
y1 = min(h, y0 + side)
out = out.crop((x0, y0, x1, y1))
if out.size[0] != out.size[1]:
    side = max(out.size)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(out, ((side - out.size[0]) // 2, (side - out.size[1]) // 2))
    out = canvas

out_session.parent.mkdir(parents=True, exist_ok=True)
out_assets.parent.mkdir(parents=True, exist_ok=True)
out.save(out_session, "PNG")
out.save(out_assets, "PNG")
print("saved", out.size)

aout = np.array(out)
print(
    "alpha0",
    int((aout[:, :, 3] == 0).sum()),
    "opaque",
    int((aout[:, :, 3] > 200).sum()),
)

# Recount peaks in output far-left
lw = int(aout.shape[1] * 0.28)
ip = (
    (aout[:, :lw, 3] > 160)
    & (aout[:, :lw, 0] + 5 > aout[:, :lw, 1])
    & (aout[:, :lw, 0] > 70)
)
rs = ip.sum(axis=1).astype(np.float64)
sm = np.convolve(rs, np.ones(5) / 5, mode="same")
final = []
for i in range(10, aout.shape[0] - 10):
    if sm[i] < 12:
        continue
    if sm[i] >= sm[i - 1] and sm[i] >= sm[i + 1]:
        if sm[i] >= sm[i - 3] and sm[i] >= sm[i + 3]:
            if not any(abs(i - j) < 30 for j, _ in final):
                final.append((i, sm[i]))
print("final peaks", sorted(final, key=lambda t: t[0]))
