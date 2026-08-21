# Cannon.js / rigid-body physics investigation

## Question
Should Scrapstorm League switch vehicle dynamics to **cannon-es** (or Rapier)?

## Short answer
**No — keep the arcade fixed-step handler.** Integrate Cannon only if we later need stacking debris piles, free-falling wrecks as rigid bodies, or jointed trailers. Combat kart feel is intentionally *not* a full vehicle sim.

## Evidence (stack + genre)

| Option | Fit for scrap combat racer | Cost |
| --- | --- | --- |
| **Hand-rolled arcade** (current) | Best: drift meter, mini-turbo, class grip, soft combat | Zero dep, fully deterministic |
| **cannon-es** | Good for boxes/spheres; vehicle suspension needs custom raycast car | ~50–100 KB + tuning hell for kart feel |
| **@react-three/rapier** | Strong character controllers; vehicles still custom | WASM load, more wiring |
| Full **Ammo/Bullet** | Overkill | Huge |

Skill guidance (`collision-physics.md`, `3d-libs.md`, racing-kart playbook): arcade racers should use **heading + speed + lateral** with fixed timestep, not a full rigid-body vehicle.

## What we *did* take from Cannon-style solvers
1. **Mass-weighted positional correction** (already present, strengthened).
2. **Impulse along contact normal** with restitution damped by soft surface.
3. **Oriented bounding box (OBB) narrowphase** instead of pure circle — less corner snag, class-sized hitboxes.
4. **Damage impulse → visual mesh dents** (presentation layer on the modular mesh).
5. **Fixed timestep + accumulator** remains the stability foundation (Gaffer).

## If we ever add Cannon later
- Use it for **scenery debris / wreck pieces only**, not player drive.
- Step Cannon at the same `FIXED_DT` as the arcade sim.
- Do **not** drive player `x/z/yaw` from Cannon — map visuals onto arcade state.

## Decision
Ship improved arcade collision + mesh damage. Document Cannon as optional debris backend, not the drive model.
