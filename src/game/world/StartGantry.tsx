/**
 * The start/finish gantry: structure, written signage, and a real light tree.
 *
 * ── the clipping bug this replaces ────────────────────────────────────
 *
 * The old gantry hung its crossbeam at y = 8.5 and its board at 8.95, with a
 * comment saying the board "sits above the chase camera (which rides ~7.8 world
 * units up)". 7.8 is the camera's height AT REST. `CHASE.heightBase` is 7.2 and
 * `heightGain` adds another 1.5 with speed, on top of the car's own 0.55 ride
 * height and up to 0.68 of shake — so at racing pace the rig is between 8.3 and
 * 10.2 metres above the road and flew THROUGH the crossbeam and the board on
 * every single lap. With a 0.35m near plane the result is a dark slab wiping
 * across the frame at the exact moment the lap timer flips.
 *
 * The fix is not a bigger number. It is that the number is now DERIVED: the
 * clearance is computed from the same `CHASE` constants the camera uses, so
 * retuning the rig cannot silently put the gantry back in the frame. Anything
 * overhead sits above `GANTRY_CLEAR`; nothing is authored below it.
 *
 * ── draw calls, and where the budget for the other set pieces came from ──
 *
 * The old gantry was SEVEN separate `<mesh>` elements — two posts, a crossbeam,
 * a board, a red band and two paint strips — each with its own inline material,
 * on every tier including the 25fps low tier. This draws:
 *
 *   1  merged vertex-coloured structure (posts, beam, sign frame, road paint)
 *   1  signage atlas (one canvas texture, four lettered panels)
 *   1  InstancedMesh of ten light pods
 *
 * Three against seven, on every tier, with more in the frame than before. That
 * saving is deliberate and is what pays for the tunnel bore and the car carrier
 * on the low tier — see the report.
 *
 * ── the text is drawn, not fetched ────────────────────────────────────
 *
 * `public/assets/` is gitignored and Vite caches its directory listing at
 * startup, so a generated PNG is an asset that 404s until the dev server is
 * restarted and that no clone of this repo has. A canvas is reproducible by
 * definition, ships in the commit, costs one 1024x512 texture, and can be read
 * and corrected in a diff. Every panel lives on ONE atlas so the whole sign set
 * is a single draw.
 */
import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { GameSimulation } from "../sim";
import { FRAME } from "./framePriority";
import {
  ATLAS_H,
  ATLAS_W,
  UV,
  structureGeometry,
} from "./setpieceGeometry";
import { getTrackSamples } from "../track";

function drawAtlas(): HTMLCanvasElement | null {
  if (typeof document === "undefined") return null;
  const cv = document.createElement("canvas");
  cv.width = ATLAS_W;
  cv.height = ATLAS_H;
  const g = cv.getContext("2d");
  if (!g) return null;

  const grime = (x: number, y: number, w: number, h: number) => {
    // A flat plate reads as a UI element pasted into the world. Two passes of
    // vertical streaking is the cheapest thing that makes it a metal sign that
    // has been outside.
    g.save();
    g.globalAlpha = 0.09;
    g.fillStyle = "#000";
    for (let i = 0; i < 90; i++) {
      const sx = x + Math.random() * w;
      const sw = 1 + Math.random() * 5;
      const sh = h * (0.2 + Math.random() * 0.8);
      g.fillRect(sx, y + h - sh, sw, sh);
    }
    g.restore();
  };

  // ── banner: the league name, on a dark plate with a red kicker ──
  g.fillStyle = "#15120f";
  g.fillRect(0, 0, ATLAS_W, 256);
  g.fillStyle = "#b91c1c";
  g.fillRect(0, 214, ATLAS_W, 26);
  g.fillStyle = "#f5f3ef";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.font = "800 132px Impact, 'Arial Narrow', Haettenschweiler, sans-serif";
  g.fillText("SCRAPSTORM", ATLAS_W * 0.5, 96, ATLAS_W - 60);
  g.font = "700 68px Impact, 'Arial Narrow', Haettenschweiler, sans-serif";
  g.fillStyle = "#d6d0c6";
  g.fillText("L E A G U E", ATLAS_W * 0.5, 176, ATLAS_W - 200);
  grime(0, 0, ATLAS_W, 256);

  // ── START / FINISH plate ──
  g.fillStyle = "#0f0d0b";
  g.fillRect(0, 256, 512, 174);
  g.strokeStyle = "#7c7367";
  g.lineWidth = 6;
  g.strokeRect(10, 266, 492, 154);
  g.fillStyle = "#f7f5f1";
  g.font = "700 74px Impact, 'Arial Narrow', sans-serif";
  g.fillText("START", 256, 312);
  g.fillStyle = "#b91c1c";
  g.fillRect(70, 346, 372, 5);
  g.fillStyle = "#f7f5f1";
  g.fillText("FINISH", 256, 388);
  grime(0, 256, 512, 174);

  // ── sponsor / sector plate ──
  g.fillStyle = "#231a12";
  g.fillRect(512, 256, 512, 174);
  g.fillStyle = "#e8b04b";
  g.font = "700 60px Impact, 'Arial Narrow', sans-serif";
  g.fillText("SECTOR 7", 768, 306);
  g.fillStyle = "#cbbfa8";
  g.font = "600 44px 'Arial Narrow', sans-serif";
  g.fillText("SALVAGE & FUEL", 768, 362);
  g.fillStyle = "#8a7a5e";
  g.font = "600 28px 'Arial Narrow', sans-serif";
  g.fillText("NO RECOVERY BEYOND THIS LINE", 768, 406);
  grime(512, 256, 512, 174);

  // ── kerb strip: hazard chevrons, used on the paint band ──
  g.fillStyle = "#e9e6e0";
  g.fillRect(0, 430, ATLAS_W, 82);
  g.fillStyle = "#1b1917";
  for (let x = -80; x < ATLAS_W; x += 96) {
    g.beginPath();
    g.moveTo(x, 512);
    g.lineTo(x + 48, 430);
    g.lineTo(x + 96, 430);
    g.lineTo(x + 48, 512);
    g.closePath();
    g.fill();
  }
  grime(0, 430, ATLAS_W, 82);
  return cv;
}

/* ── lights ───────────────────────────────────────────────────────────── */

const RED_OFF = new THREE.Color("#2a0b0a");
const RED_ON = new THREE.Color("#ff2418");
const GREEN_OFF = new THREE.Color("#0a2113");
const GREEN_ON = new THREE.Color("#37ff6a");

export function StartLineGantry({
  sim,
  trackEpoch,
}: {
  sim: GameSimulation;
  trackEpoch?: number;
}) {
  const s0 = getTrackSamples()[0] ?? { x: 0, y: 0, z: 0, yaw: 0, width: 26 };
  const built = useMemo(
    () => structureGeometry(s0.width ?? 26),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [trackEpoch, s0.width],
  );

  const tex = useMemo(() => {
    const cv = drawAtlas();
    if (!cv) return null;
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    t.needsUpdate = true;
    return t;
  }, []);

  const frameMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.62,
        metalness: 0.45,
        envMapIntensity: 0.8,
      }),
    [],
  );
  const signMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        map: tex ?? null,
        color: tex ? 0xffffff : 0xd8d4cc,
        roughness: 0.78,
        metalness: 0.05,
        side: THREE.DoubleSide,
        envMapIntensity: 0.6,
      }),
    [tex],
  );
  // 8x5 is 64 triangles a pod. A start lamp is a few pixels across at the
  // distance it is read from, and ten of them are the whole light tree.
  const podGeo = useMemo(() => new THREE.SphereGeometry(0.28, 8, 5), []);
  const podMat = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        // Unlit and untonemapped: a start light is a light, and letting the
        // grade pull it around makes green read as grey at dusk.
        toneMapped: false,
      }),
    [],
  );

  const pods = useRef<THREE.InstancedMesh>(null);
  const stage = useRef(-99);

  useEffect(
    () => () => {
      built.frame.dispose();
      built.signs.dispose();
    },
    [built],
  );
  useEffect(
    () => () => {
      tex?.dispose();
      frameMat.dispose();
      signMat.dispose();
      podGeo.dispose();
      podMat.dispose();
    },
    [tex, frameMat, signMat, podGeo, podMat],
  );

  /*
   * Pod transforms are written once; only the colours change.
   *
   * The instance matrix is a per-frame upload if you touch it, and the light
   * tree never moves. `stage` gates the colour upload too, so a whole race costs
   * six buffer writes rather than 21600.
   */
  useEffect(() => {
    const m = pods.current;
    if (!m) return;
    const t = new THREE.Matrix4();
    for (let i = 0; i < built.lightSlots.length; i++) {
      const s = built.lightSlots[i]!;
      // -Z is the leading face: the lenses sit just proud of their housings,
      // facing the cars on the grid rather than the empty road behind them.
      t.makeTranslation(s.x, s.y, -0.92);
      m.setMatrixAt(i, t);
    }
    m.instanceMatrix.needsUpdate = true;
    stage.current = -99;
  }, [built]);

  useFrame(() => {
    const m = pods.current;
    if (!m) return;
    const st = sim.state;
    /*
     * -1 idle, 0..5 reds filling, 6 green.
     *
     * `RACE.countdownSec` is 3 and the sim counts it down in seconds, so the
     * five reds are spread over that rather than mapped one per second — five
     * lights on a three second countdown is the F1 read, and it is also the only
     * way the last light has anything to do just before the flag.
     */
    let want: number;
    if (st.phase === "countdown") {
      const total = Math.max(0.001, st.countdown > 3 ? st.countdown : 3);
      want = Math.max(0, Math.min(5, Math.ceil((1 - st.countdown / total) * 5)));
    } else if (st.phase === "racing" && st.time < 4) {
      want = 6;
    } else {
      want = -1;
    }
    if (want === stage.current) return;
    stage.current = want;
    for (let i = 0; i < built.lightSlots.length; i++) {
      const col = i % 2;
      const red = col === 0;
      const on = red ? want >= 0 && i / 2 < want && want < 6 : want === 6;
      m.setColorAt(i, red ? (on ? RED_ON : RED_OFF) : on ? GREEN_ON : GREEN_OFF);
    }
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }, FRAME.LATE);

  return (
    <group position={[s0.x, s0.y + 0.02, s0.z]} rotation={[0, s0.yaw ?? 0, 0]}>
      <mesh geometry={built.frame} material={frameMat} castShadow receiveShadow />
      <mesh geometry={built.signs} material={signMat} />
      <instancedMesh
        ref={pods}
        args={[podGeo, podMat, built.lightSlots.length]}
        frustumCulled={false}
      />
    </group>
  );
}
