# Video brief — Scrapstorm League

Prompts for generated video, plus the reference stills each one needs.

Written against what the game actually contains: six circuits with their own
time of day and palette (see `src/game/world/environments/presets.ts`), a
fifteen-rival ladder, and the story in `src/game/story.ts` — Marrow put you into
the flare stack on the last lap eighteen months ago, the league called your
wreck salvage, and he has been driving your car since.

## How to use this

Every entry has three parts:

- **REF** — the still to generate first and feed in as an image reference.
  Generate with `node scripts/gen-refs.mjs`, or reuse an existing frame.
- **PROMPT** — the video prompt.
- **CUT** — where it plays and how long it needs to be.

Two rules that matter more than the wording:

1. **Match the circuit's light.** Foundry Pit is furnace-lit night with no sun,
   Sable Mile is hard noon, Dead Mile is first light. A clip graded like the
   wrong circuit reads as stock footage the moment it cuts to gameplay.
2. **Never show a HUD.** These sit next to real gameplay; a fake HUD in a
   pre-render is the single most obvious tell.

Aspect: 16:9 for cutscenes and trailers. Loops that sit behind menus should be
generated with no camera cut at all, so they can be cross-faded to themselves.

---

## 1. Cold open — the wreck that starts the story

**REF** — `refs/mesh/cars/interceptor-scout.jpg` for the car; a still of Ash
Spire at dusk for the light.

**PROMPT**
> Low, wide shot from track level at dusk in a desert stadium circuit. A
> battered orange and steel racing car slides sideways at speed, sparks
> streaming from its flank, and slams into a stack of burning flare drums. The
> impact throws the drums and a wall of orange sparks across the frame. Dust and
> smoke roll toward camera and swallow the wreck. Handheld, slight camera shake,
> anamorphic flare from the low sun. Photoreal, grainy, warm orange and deep
> blue grade. No text, no UI, no on-screen graphics.

**CUT** — 6–8s, plays once before the first race of a new career.

---

## 2. Title reveal

**REF** — a wide of the Ash Spire start gantry at dusk.

**PROMPT**
> Slow push-in along an empty desert race circuit at dusk toward a rusted steel
> start gantry silhouetted against a low sun. Heat haze rises off the tarmac.
> Dust drifts across frame. Absolutely still and quiet, no cars, no movement
> except the haze. Photoreal, cinematic, warm backlight, long lens compression.
> No text, no UI.

**CUT** — 4s, holds under the title card. Title is composited in engine, not
generated, so it stays sharp and localisable.

---

## 3. Menu loop — the yard

**REF** — `refs/mesh/characters/mechanic.jpg`.

**PROMPT**
> Locked-off wide of a scrapyard workshop at dusk, lit by a single work lamp and
> a shower of welding sparks. A wiry mechanic in oil-stained coveralls works on
> the rear quarter of a stripped combat racing car. Sparks fall and fade. Steam
> drifts. Nothing else moves; the camera never moves. Photoreal, warm pools of
> light against deep shadow. No text, no UI.

**CUT** — 10–12s, seamless loop behind the main menu. Ask for no camera move so
the loop point is invisible.

---

## 4. Garage / car select

**REF** — `refs/mesh/cars/bruiser-ram.jpg`.

**PROMPT**
> Slow orbit around a heavy armoured combat racing car on a workshop floor,
> spiked ram plate forward, welded plate armour, twin exhaust stacks. Lit from
> above by two hanging work lamps, cool fill from an open roller door behind.
> Dust motes in the light. The car does not move. Photoreal, shallow depth of
> field, reflections crawling across bare metal. No text, no UI.

**CUT** — 8s, loops behind the garage. Generate one per class if budget allows;
the silhouettes differ enough to be worth it.

---

## 5. Pre-race — the grid

**REF** — a still of the circuit you are cutting to.

**PROMPT**
> Ground-level shot between the front wheels of four battered combat racing cars
> lined up abreast on a desert start line. Exhaust shimmer, tyres rocking
> against the brakes, dust curling off the tarmac. A starter light rig hangs
> overhead. Tension, no movement forward. Photoreal, low sun, long lens, heavy
> heat haze. No text, no UI.

**CUT** — 3s, before the countdown hands control to the player. Keep it short —
this one plays every race and will wear out fastest.

---

## 6. Rival introduction (Blacklist card)

**REF** — the matching `refs/mesh/characters/rival-*.jpg`.

**PROMPT**
> Slow push toward a driver standing beside their car in a scrapyard at dusk,
> helmet under one arm, staring straight down the lens. Backlit by a low sun so
> they read mostly as silhouette with a rim of orange light. Dust drifting.
> They do not move. Photoreal, shallow depth of field, cold shadow against warm
> rim light. No text, no UI.

**CUT** — 3–4s, before a rival duel. Generate per rival from their own
reference so the roster reads as fifteen people, not one person relit. The
name and rank are composited in engine.

---

## 7. Marrow — the antagonist

**REF** — `refs/mesh/characters/antagonist-warlord.jpg`.

**PROMPT**
> Slow low-angle push toward a scarred champion driver in patched armour plate
> and leather, trophy plating on the shoulders, goggles pushed up on his
> forehead. He is leaning against a black and gold armoured car, arms folded,
> and he laughs once at the camera. Night, lit by the car's own headlights from
> behind, hard shadows. Photoreal, cold and contrasty. No text, no UI.

**CUT** — 5s, before the rank-1 duel. This is the only clip where a character
performs rather than holds — it is the payoff of the whole ladder.

---

## 8. Victory

**PROMPT**
> A battered combat racing car slides to a stop in a cloud of dust as the sun
> drops behind a desert ridge. Steam and smoke pour off the hot bodywork. The
> dust catches the last low light and glows orange. Slow motion, camera low and
> static. Photoreal, warm, dust-heavy backlight. No text, no UI.

**CUT** — 5s over the results screen.

---

## 9. Defeat

**PROMPT**
> A wrecked combat racing car sits still in the desert at dusk, one headlight
> flickering, thin smoke rising straight up in the windless air. The camera
> holds, far back and level. Nothing moves except the smoke and the failing
> light. Photoreal, cold blue shadow, desaturated. No text, no UI.

**CUT** — 4s. Deliberately static and quiet against the victory clip's motion.

---

## 10. Per-circuit establishing shots

One each, played the first time a circuit unlocks. Match the environment
exactly — the palette is already defined in code.

- **Ash Spire** — *"Aerial push over a wide desert stadium circuit at late
  afternoon, long shadows from a low sun, orange sand and dark tarmac, a scrap
  refinery skyline on the horizon."*
- **Cinder Bowl** — *"Slow drift across a volcanic ash bowl at dusk, grey
  clinker underfoot, a jagged crater rim silhouetted against a deep violet sky,
  faint heat glow in the ground."*
- **Foundry Pit** — *"Low tracking shot through a furnace-lit industrial pit at
  night. Molten orange light from tap holes, black slag underfoot, towering
  stacks and gantries enclosing the space. No sky visible."*
- **Rustline** — *"Handheld push down a narrow corridor between towering stacks
  of crushed cars and shipping containers, in a brown-out dust storm. Visibility
  under a hundred metres, everything sepia."*
- **Sable Mile** — *"Aerial over a vast black basalt plain under hard noon sun,
  white alkali flats between dark rock, a thin ribbon of road running to the
  horizon. Brutally bright, short shadows."*
- **Dead Mile** — *"Slow aerial along a pipeline haul road at first light, cold
  lilac shadow in the hollows and gold on the ridges, pumping stations receding
  to a far turn."*

**CUT** — 5s each.

---

## 11. Announce trailer (60s)

The one piece worth real effort. Structure, not a single prompt — generate each
beat separately and cut them together.

| beat | length | content |
|---|---|---|
| Cold open | 0:00–0:08 | The wreck (clip 1). Ends on black. |
| Voice-over | 0:08–0:14 | Ash Spire empty at dusk, slow push. *"They called it salvage."* |
| Build | 0:14–0:30 | Fast cuts, one per circuit — noon basalt, furnace pit, dust storm, first light. Each 2–3s, cut on motion. |
| Combat | 0:30–0:44 | Rockets leaving a launcher, a rival cartwheeling off a guard rail, a saw blade sparking off armour, a car ploughing a rail flat. Accelerating cuts. |
| Marrow | 0:44–0:52 | Clip 7. Cuts to black on the laugh. |
| Payoff | 0:52–0:60 | Two cars side by side into the flare stack, last lap, sparks. Hard cut to title. |

**Music** — original arena rock, 4/4 around 148 BPM, overdriven guitars, gang
vocals. `scripts/gen-music.mjs` already generates in this idiom; the prompts
name no artist and neither should these.

---

## 12. Gameplay trailer (30s)

Prefer captured footage over generated video here — a gameplay trailer whose
gameplay is generated is a lie the audience will catch. Use generated clips only
for the cold open and the title. Capture with:

```bash
node scripts/qa-visual.mjs --tiers high
```

and the `?capture` flag, which enables `preserveDrawingBuffer`.

---

## Generating the reference stills

```bash
node scripts/gen-refs.mjs --set mesh --only characters
node scripts/gen-refs.mjs --set mesh --only cars
```

Existing stills are in `refs/mesh/`. They are deliberately clean, unlit and
label-free — good as *subject* references, but pair them with a gameplay frame
whenever the clip needs the circuit's light, because the stills carry none.
