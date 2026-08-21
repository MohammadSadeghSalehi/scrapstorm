# Video clip briefs

Prompts for the cinematics, written to be pasted straight into a video
generator. You generate the clips; ElevenLabs supplies the voice over them.

## Conventions these all assume

**Keep them short.** Most Wanted 2005's story worked because it was delivered in
motion and got out of the way. 6–12 seconds each. A 30-second cutscene in a
racing game is a skip button with extra steps.

**No dialogue in frame.** Every clip is scored and narrated, never lip-synced —
generated lip-sync is the fastest way to make something look cheap, and VO over
action is both cheaper and more effective. Faces can be shown; mouths should not
be the subject.

**One idea per clip.** If a brief needs "and then", it is two clips.

**Match the game's grade.** Desert dusk: low warm sun, long shadows, dust in the
air, deep blue-shifted shadows. The in-game grade is an ASC CDL with a warm
highlight lift and cool shadow roll — clips that ignore it will feel pasted in.

---

## 1 · Cold open — the league (8s, plays once on first launch)

> Aerial drone shot at golden hour descending toward a desert canyon. Below, a
> makeshift racing circuit cut through scrapland: welded grandstands packed with
> spectators, floodlight towers, burning barrels, banners snapping in the wind.
> Four armoured cars tear past the start gantry throwing dust. Camera keeps
> descending until the crowd noise and engines fill the frame. Cinematic
> anamorphic, warm low sun, heavy atmospheric dust, film grain.

VO: the league's premise in two sentences. Establishes the world, nothing else.

---

## 2 · The player arrives (7s)

> Low tracking shot, camera at wheel height, following a single battered orange
> combat car rolling slowly through a scrapyard gate into the pit area. Welders
> and mechanics look up as it passes. The car is outclassed and it shows —
> mismatched panels, no trophy plating. Dust, sparks from a welder, dusk light
> raking across the frame.

VO: the mechanic's line. Sets the underdog framing.

---

## 3 · Rival intro (6s each, one per Blacklist rival — reuse the template)

> Slow push-in on a single armoured combat car parked in a floodlit pit bay,
> engine running, driver silhouetted behind the wheel. Heat haze off the
> exhaust. The car's design language is [DISTINCT FEATURE]. Hard rim light from
> one side, deep shadow on the other, dust motes in the beam. Ends on a slow
> rack focus to the driver's face.

Swap `[DISTINCT FEATURE]` per rival — the roof turret, the ram plate, the twin
disc launchers. Same framing every time so the *car* is what differentiates
them; that repetition is the point and it is how MW05's Blacklist reads as a
ladder.

VO: the rival's taunt, one line.

---

## 4 · First blood (9s)

> Two armoured cars side by side at speed on a desert straight, trading paint.
> The heavier one swings into the lighter one; sparks explode from the contact
> point, a fender tears loose and tumbles into the camera. Whip pan follows the
> debris, then snaps back to the cars disappearing into a dust wall. Handheld
> energy, motion blur, low sun flare.

VO: none. Let the impact carry it.

---

## 5 · The wreck (6s)

> A combat car catches a barrier at speed and rolls. Slow motion at the apex of
> the roll — debris and glass suspended, sun behind — then a hard cut back to
> real time as it lands and slides to a stop in a cloud of dust. Camera low and
> static, letting the car leave frame.

Used on elimination/defeat. The slow-motion apex is the whole shot; everything
else is setup and payoff.

---

## 6 · Warlord reveal (10s)

> Night. Floodlights snap on one bank at a time, revealing an oversized black
> and gold armoured car in an arena, alone. Trophy plating welded across its
> flanks — visibly made from the wrecked panels of other cars. Camera orbits
> slowly from the rear to the front three-quarter as the last lights come up.
> Engine idles, deep and uneven. Cold white light, heavy contrast.

VO: the antagonist, one line. This is the only clip allowed to be slow.

---

## 7 · Victory (7s)

> A battered orange combat car crosses under the start gantry, crowd erupting in
> the scrap grandstands, flares and dust in the air, floodlights flaring into
> the lens. Camera cranes up and back as the car slides into a celebratory spin.
> Golden hour, lens flare, confetti of torn banner scraps.

---

## 8 · Ending (12s)

> Wide static shot at dawn: the desert circuit empty and quiet, wrecks being
> dragged away, dust settling. A single car sits at the start line, engine
> ticking as it cools. Slow push in. Cut to black.

VO: the closing line. Dawn is deliberate — every other clip is dusk or night, so
this one reads as an ending on light alone.

---

## Production notes

- **Aspect**: 16:9, and keep the action off the extreme edges — the HUD's
  letterbox bars crop into the top and bottom during cinematics.
- **Audio**: deliver clips mute. The engine buses, reverb zones and music
  crossfade already exist; a clip with baked-in audio will fight them and cannot
  be ducked under VO.
- **Length discipline**: if a clip needs to run long, cut it and let the VO
  bridge. VO is cheap to regenerate; video is not.
- **Continuity**: the player's car is orange and battered and stays that way
  until the final act. Rivals are individually coloured — keep them consistent
  with `refs/characters/rival-roster.jpg`.
