# T04 — The canvas is not black

r3f's default renderer does not run if something else takes `useFrame` at
priority greater than 0 without drawing. Postprocessing's composer does that
on purpose. Low tier has no composer, so it must draw with `SceneRenderer`.

**Visible spec:** Set graphics to low. Start a heat. You can see the desert,
the road, and the cars. A 160 fps black rectangle is a fail.

**Do not** add `useFrame(..., 1)` for gameplay unless you also draw, and do
not delete `SceneRenderer` to "simplify" low tier.
