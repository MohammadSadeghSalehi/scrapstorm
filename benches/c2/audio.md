# C2 restore — audio

The ablated tree is this repo with `src/game/audio/` emptied of DSP. Restore
the stub-testable mixer: explosions, engine, tyres, weapons, crowd, music
state machine, VO budget.

Oracle: `node scripts/probe-audio.mjs` exits 0. No Web Audio hardware required.
