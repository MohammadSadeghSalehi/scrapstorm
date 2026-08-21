# T02 — Switching circuit switches the road

The game has six circuits. Changing track in the garage must change the ribbon
the cars drive, the heightfield, and the scenery.

**Visible spec:** Start a heat on Ash Spire, then a heat on Cinder Bowl. The
minimap shape, the start-line heading, and the jump crests are different. A
car that completes a lap on Bowl is not secretly lapping Spire's samples.

**Do not** capture `TRACK_SAMPLES` at module init. Call `getTrackSamples()`.
