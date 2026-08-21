# C2 restore — tires

The ablated tree is this repo with `src/game/tires.ts` removed and its call
sites stubbed. Restore thermal grip: compounds per class, heat from slip and
brake, a HUD band from cold to critical, and a measurable grip penalty outside
the optimal window.

Oracle: `TIRE_TEMP` exists, a vehicle's tire state changes over a driven lap,
and `tsc` is clean. No renderer.
