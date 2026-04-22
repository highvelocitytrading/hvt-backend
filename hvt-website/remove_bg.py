"""
Remove pure-black background from PNG frames using luminance-to-alpha.
Works correctly for glowing/additive subjects (blue glowing bull on black BG).

Approach:
  - Compute per-pixel luminance
  - Use luminance as the new alpha (boosted so dim glows stay visible)
  - Un-premultiply the RGB channels so the colour is correct at that alpha
  - Preserve any pixels that were already transparent
"""

import os
import glob
import numpy as np
from PIL import Image

FRAMES_DIR = os.path.join(os.path.dirname(__file__), 'assets', 'frames')
PATTERN    = os.path.join(FRAMES_DIR, 'Sequence 01_*.png')

# How aggressively to lift dim glows into the alpha.
# 2.5 → a pixel with lum=100 gets alpha=250 (nearly opaque)
# Lower = more transparent edges, Higher = harder edges
BOOST = 2.8

files = sorted(glob.glob(PATTERN))
print(f"Found {len(files)} frames in {FRAMES_DIR}")

for idx, path in enumerate(files):
    img = Image.open(path).convert('RGBA')
    arr = np.array(img, dtype=np.float32)

    R, G, B, A = arr[:, :, 0], arr[:, :, 1], arr[:, :, 2], arr[:, :, 3]

    # Standard luminance (perceptual)
    lum = 0.299 * R + 0.587 * G + 0.114 * B

    # New alpha: luminance × boost, clamped to [0, 255]
    new_alpha = np.clip(lum * BOOST, 0, 255)

    # Preserve pixels that were already fully transparent in the source
    new_alpha[A == 0] = 0

    # Un-premultiply: recover the "true" colour at the new (lower) alpha.
    # Without this, dark-bg colours appear darker than intended after compositing.
    safe_a = np.where(new_alpha > 0, new_alpha, 1.0)
    factor = 255.0 / safe_a

    new_R = np.clip(R * factor, 0, 255)
    new_G = np.clip(G * factor, 0, 255)
    new_B = np.clip(B * factor, 0, 255)

    # Zero out colour where fully transparent (avoid colour bleed)
    zero = new_alpha == 0
    new_R[zero] = 0
    new_G[zero] = 0
    new_B[zero] = 0

    out = np.stack([new_R, new_G, new_B, new_alpha], axis=2).astype(np.uint8)
    Image.fromarray(out, 'RGBA').save(path)

    print(f"  [{idx + 1}/{len(files)}] {os.path.basename(path)}")

print("\nDone — all frames processed.")
