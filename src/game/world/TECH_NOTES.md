# Scrapstorm tech notes

## Spring–damper suspension

Each tire integrates a second-order spring toward a load-dependent target:

```
target = rest + load * 0.72          // equilibrium under weight / squat
err    = target - compress
vel   += (err * k - vel * c) * dt    // F = kx - cv  (spring − damper)
compress += vel * dt
```

- `k` (spring): bruiser 42, interceptor 34, trickster 26 — stiffer = less travel  
- `c` (damper): ~k/6 — kills oscillation; higher on landings  
- Body pitch/roll from wheel asymmetry: `pitch ∝ (rear − front)`, `roll ∝ (right − left)`  
- Visual: body group sinks, wheels stay planted (Kenney pivots)

## Meshopt compression

glTF meshopt packs positions as **normalized Int16**.  
`BufferGeometry.applyMatrix4` writes floats back into Int16 → **corrupted cube**.

Always dequantize first:

```ts
v.set(attr.getX(i), attr.getY(i), attr.getZ(i)).applyMatrix4(m);
// write into Float32Array
```

Then merge by paint kind (~6 draw calls) for concept cars. Kenney cars keep hierarchy for wheel spin.

## Bloom

```tsx
<Bloom
  intensity={0.55}           // boost → ~0.9
  luminanceThreshold={0.62}  // only bright emissives/sun
  mipmapBlur
  radius={0.85}
/>
```

Enabled on all quality tiers (softer on low).
