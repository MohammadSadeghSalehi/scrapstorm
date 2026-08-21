# T06 — The countdown does not run on a half-built world

Mounting the race world compiles shaders, builds terrain, and decodes GLBs.
If the 3-2-1 clock runs during that work, the start is a stutter.

**Visible spec:** From the garage, start a race. The loading screen covers
warmup. When the lights drop, the world is already there and the first seconds
are smooth. The game never sits on a loading screen forever: the gate has a
watchdog.

**Do not** call `sim.tick` while `isSimHeld()` is true. Do not hide the canvas
to fake a load.
