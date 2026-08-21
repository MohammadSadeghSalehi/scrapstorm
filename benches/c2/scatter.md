# C2 restore — scatter

The ablated tree is this repo with `src/game/world/scatter/` removed. Restore
roadside scatter that follows `getTrackSamples()`, culls, and does not place
props on the racing line.

Oracle: `ScatterLayer.tsx` exists, uses `getTrackSamples` or a placement module
that does, and `tsc` is clean. No Playwright.
