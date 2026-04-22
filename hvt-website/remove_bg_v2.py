"""
Second-pass background removal.

The first pass (remove_bg.py) applied luminance*BOOST as alpha + un-premultiply.
That left dark-blue background pixels at ~31% opacity — still visible as a box.

This script:
  1. Mathematically reverses the first pass to recover the original RGBA values
  2. Applies a proper soft-threshold to kill dark background pixels (lum < 45 → alpha=0)
  3. Stores the ORIGINAL RGB (no un-premultiply) so the browser's screen-blend mode
     can composite the glow correctly without colour distortion
"""

import os, glob
import numpy as np
from PIL import Image

FRAMES_DIR     = os.path.join(os.path.dirname(__file__), 'assets', 'frames')
PATTERN        = os.path.join(FRAMES_DIR, 'Sequence 01_*.png')
FIRST_PASS_BOOST = 2.8   # must match what remove_bg.py used

# Luminance thresholds for the new alpha curve
THRESH_LOW  = 45   # below → fully transparent  (kills dark-blue background)
THRESH_HIGH = 140  # above → fully opaque        (keeps bright wireframe/glow)

files = sorted(glob.glob(PATTERN))
print(f"Processing {len(files)} frames …")

for idx, path in enumerate(files):
    img = Image.open(path).convert('RGBA')
    arr = np.array(img, dtype=np.float32)

    R_p, G_p, B_p, A_p = arr[:,:,0], arr[:,:,1], arr[:,:,2], arr[:,:,3]

    # ── Step 1: recover original RGB ──────────────────────────────────────
    # First pass stored: R_p = min(R_orig * 255/A_p, 255)
    # Invert: R_orig ≈ R_p * A_p / 255  (exact except where 255-cap was hit)
    orig_R = np.clip(R_p * A_p / 255.0, 0, 255)
    orig_G = np.clip(G_p * A_p / 255.0, 0, 255)
    orig_B = np.clip(B_p * A_p / 255.0, 0, 255)

    # ── Step 2: compute original luminance ────────────────────────────────
    lum = 0.299 * orig_R + 0.587 * orig_G + 0.114 * orig_B

    # ── Step 3: threshold-based alpha with smooth transition ──────────────
    t = np.clip((lum - THRESH_LOW) / (THRESH_HIGH - THRESH_LOW), 0.0, 1.0)
    new_alpha = t * t * (3.0 - 2.0 * t) * 255.0   # smoothstep

    # Honour pixels that were already fully transparent in the first pass
    new_alpha[A_p == 0] = 0.0

    # ── Step 4: store ORIGINAL RGB + new alpha ────────────────────────────
    # No un-premultiply — the canvas uses mix-blend-mode: screen, which
    # handles dark pixels naturally (dark + dark = dark, bright + dark = bright)
    zero = new_alpha == 0
    out_R = orig_R.copy(); out_R[zero] = 0
    out_G = orig_G.copy(); out_G[zero] = 0
    out_B = orig_B.copy(); out_B[zero] = 0

    out = np.stack([out_R, out_G, out_B, new_alpha], axis=2).astype(np.uint8)
    Image.fromarray(out, 'RGBA').save(path)

    print(f"  [{idx+1}/{len(files)}] {os.path.basename(path)}")

print("\nDone.")
