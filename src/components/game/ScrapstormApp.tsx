/**
 * App shell — paints menu immediately (no Three.js), then streams race engine.
 */
import { useCallback, useEffect, useRef, useState, type ComponentType } from "react";
import type {
  SimState,
  TrackId,
  VehicleClassId,
  MatchPhase,
  VehicleState,
} from "@/game/types";
import { VEHICLE_CLASSES } from "@/game/classes";
import {
  applyMissionMeta,
  applyRaceReward,
  loadMeta,
  paintHex,
  saveMeta,
  selectPaint,
  spendScrap,
  tryUnlockPaint,
  type MetaState,
} from "@/game/meta";
import {
  applyMissionEffects,
  applyMissionResult,
  armMission,
  disarmMission,
  drainScrap,
  fieldPace,
  heatNormalised,
  loadCareer,
  markBeatSeen,
  missionById,
  missionCost,
  pendingIntroBeat,
  resetCareer,
  saveCareer,
  stepMission,
  summarise,
  type CareerAward,
  type CareerState,
  type MissionDef,
  type MissionRun,
  type MissionRunSummary,
} from "@/game/missions";
import { haptic } from "@/game/haptics";
/*
 * The one module from world/ this shell imports eagerly.
 *
 * `raceGate` is deliberately dependency-free — no three.js, no game modules — so
 * pulling it into the first paint costs a few hundred bytes and keeps this file
 * able to open the gate before the engine chunk has even been requested. If it
 * ever grows an import of something under world/ that touches three, this shell
 * stops painting instantly and that is the reason why.
 */
import {
  beginWorldWarm,
  closeRaceGate,
  getRaceGate,
  openRaceGate,
  setAssetProgress,
} from "@/game/world/raceGate";
import { MenuOverlay } from "./Menus";
import { RaceLoadingScreen } from "./RaceLoadingScreen";
import { CareerBoard, MissionBrief, MissionResults, StoryCard } from "./CareerMenus";
import type { HudSlice, MissionHud } from "./GameHUD";
import { Cutscene, CutsceneLoop, hasSeenCutscene, type CutsceneId } from "./Cutscene";

type GameSimulation = import("@/game/sim").GameSimulation;
type InputController = import("@/game/input").InputController;

type CanvasProps = {
  sim: GameSimulation;
  input: InputController;
  onHud: () => void;
  onPauseToggle: () => void;
  sceneKey: string;
};

type EngineKit = {
  GameCanvas: ComponentType<CanvasProps>;
  wireControlsTest: (sim: GameSimulation, input: InputController) => void;
  GameSimulation: new (
    name: string,
    classId: VehicleClassId,
    trackId: TrackId,
  ) => GameSimulation;
  InputController: new () => InputController;
  audioEngine: {
    unlock: () => void;
    playUi: (
      kind:
        | "click"
        | "confirm"
        | "countdown"
        | "go"
        | "finish"
        | "pause"
        | "lap",
    ) => void;
  };
  installAudioUnlock: () => () => void;
  snapshotHud: (s: SimState, mission?: MissionHud | null) => HudSlice;
  GameHUD: ComponentType<{ hud: HudSlice; onPause: () => void }>;
  MobileControls: ComponentType<{
    input: InputController;
    phase: MatchPhase;
    onPause: () => void;
  }>;
  GraphicsDebug: ComponentType<{ phase: string }>;
  FpsMeter: ComponentType<{ phase: string }>;
  prepareRaceAssets: (
    onProgress?: (pct: number, label: string) => void,
  ) => Promise<void>;
};

function loadName() {
  if (typeof window === "undefined") return "Racer";
  return localStorage.getItem("scrapstorm-name") || "Racer";
}

function loadClass(): VehicleClassId {
  if (typeof window === "undefined") return "interceptor";
  const c = localStorage.getItem("scrapstorm-class");
  if (c === "bruiser" || c === "trickster" || c === "interceptor") return c;
  return "interceptor";
}

function loadTrack(): TrackId {
  if (typeof window === "undefined") return "ash_spire";
  const t = localStorage.getItem("scrapstorm-track");
  if (t === "cinder_bowl" || t === "ash_spire") return t;
  return "ash_spire";
}

/** Replay ghost is opt-in — a translucent car on the grid reads as a bug. */
function loadGhostOn(): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem("scrapstorm-ghost") === "1";
}

function emptyTires(): VehicleState["tires"] {
  return [0, 1, 2, 3].map(() => ({
    compress: 0.15,
    compressVel: 0,
    lat: 0,
    long: 0,
    slip: 0,
    spin: 0,
    temp: 50,
  })) as VehicleState["tires"];
}

/** Lightweight menu state — no sim import required */
function makeShellState(
  name: string,
  classId: VehicleClassId,
  trackId: TrackId,
  phase: MatchPhase = "menu",
): SimState {
  const def = VEHICLE_CLASSES[classId];
  const player: VehicleState = {
    id: "player",
    name: name || "Racer",
    isPlayer: true,
    classId,
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    speed: 0,
    lateral: 0,
    health: def.health,
    maxHealth: def.health,
    shield: 0,
    weaponCharge: 0,
    shieldCharge: 0,
    ultimateCharge: 0,
    primaryCooldown: 0,
    defenseCooldown: 0,
    ultimateActive: 0,
    defenseActive: 0,
    decoyActive: 0,
    invuln: 0,
    wreckTimer: 0,
    boostTimer: 0,
    lap: 0,
    checkpoint: 0,
    raceProgress: 0,
    finished: false,
    finishTime: 0,
    position: 1,
    color: def.color,
    damageVisual: 0,
    dentFront: 0,
    dentLeft: 0,
    dentRight: 0,
    dentRear: 0,
    impactFlash: 0,
    lockTargetId: null,
    airTime: 0,
    nearMissBoost: 0,
    alive: true,
    hitStun: 0,
    offroadAmount: 0,
    surface: "asphalt",
    bodyRoll: 0,
    bodyPitch: 0,
    tires: emptyTires(),
    steerAngle: 0,
    tireLoad: 0,
    tireSlip: 0,
    tireTemp: 50,
    tireTempBand: "warm",
    driftMeter: 0,
    uiAccel: 0,
    lapTimes: [],
    lastLapTime: 0,
    lastHitBy: null,
    lastHitAge: 0,
  };
  return {
    phase,
    resumePhase: null,
    time: 0,
    raceTime: 0,
    countdown: 3,
    vehicles: [player],
    projectiles: [],
    mines: [],
    particles: [],
    props: [],
    events: [],
    lapCount: 3,
    seed: 1,
    playerId: "player",
    guestName: name,
    selectedClass: classId,
    selectedTrack: trackId,
    finishedOrder: [],
    cameraShake: 0,
    cameraKick: null,
    lastHitFlash: 0,
    scrapEarned: 0,
    bestLapThisRace: null,
    ghostBeaten: false,
    ghostSaved: false,
  };
}

function snapshotMenu(state: SimState): SimState {
  return {
    ...state,
    vehicles: state.vehicles.map((v) => ({
      ...v,
      lateral: 0,
      weaponCharge: 0,
      shieldCharge: 0,
      ultimateCharge: 0,
      primaryCooldown: 0,
      defenseCooldown: 0,
      ultimateActive: 0,
      defenseActive: 0,
      decoyActive: 0,
      invuln: 0,
      wreckTimer: 0,
      boostTimer: 0,
      dentFront: 0,
      dentLeft: 0,
      dentRight: 0,
      dentRear: 0,
      impactFlash: 0,
      lockTargetId: null,
      airTime: 0,
      nearMissBoost: 0,
      hitStun: 0,
      offroadAmount: 0,
      surface: "asphalt" as const,
      bodyRoll: 0,
      bodyPitch: 0,
      steerAngle: 0,
      tireLoad: 0,
      tireSlip: 0,
      driftMeter: 0,
      uiAccel: 0,
      lapTimes: v.lapTimes ? [...v.lapTimes] : [],
    })),
    events: state.events.slice(0, 4),
    projectiles: [],
    mines: [],
    particles: [],
    finishedOrder: [...state.finishedOrder],
  };
}

async function loadEngine(
  onProgress: (pct: number, msg: string) => void,
): Promise<EngineKit> {
  onProgress(12, "Race systems…");
  await new Promise((r) => requestAnimationFrame(() => r(null)));

  const [simMod, inputMod, metaHud] = await Promise.all([
    import("@/game/sim"),
    import("@/game/input"),
    import("./GameHUD"),
  ]);
  onProgress(35, "Graphics engine…");
  const sceneMod = await import("@/game/world/GameScene");
  onProgress(72, "Audio & HUD…");
  const [audioMod, mobileMod, debugMod] = await Promise.all([
    import("@/game/audio/AudioEngine"),
    import("./MobileControls"),
    import("./GraphicsDebug"),
  ]);
  onProgress(95, "Ready");
  return {
    GameCanvas: sceneMod.GameCanvas,
    wireControlsTest: sceneMod.wireControlsTest,
    GameSimulation: simMod.GameSimulation,
    InputController: inputMod.InputController,
    audioEngine: audioMod.audioEngine,
    installAudioUnlock: audioMod.installAudioUnlock,
    snapshotHud: metaHud.snapshotHud,
    GameHUD: metaHud.GameHUD,
    MobileControls: mobileMod.MobileControls,
    GraphicsDebug: debugMod.GraphicsDebug,
    FpsMeter: debugMod.FpsMeter,
    prepareRaceAssets: sceneMod.prepareRaceAssets,
  };
}

/** How long a radio line stays on screen, in RACE seconds. */
const RADIO_HOLD = 4.5;
/** Race seconds between a run resolving and the flag actually falling. */
const RESOLVE_GRACE = 2.6;

/**
 * The mission's slice of the HUD.
 *
 * Built here rather than inside snapshotHud because the run is not part of
 * SimState and must not become part of it — the sim is deliberately ignorant of
 * missions, and this function is the entire cost of keeping it that way.
 */
function missionHudFrom(
  run: MissionRun,
  radio: { text: string; until: number }[],
): MissionHud {
  return {
    name: run.def.name,
    kind: run.def.kind,
    // run.modifiers, not run.def.modifiers — the career's heat floor is applied
    // at arm time and the player is entitled to see the number they are driving
    // against, not the one that was authored.
    heat: run.modifiers.heat,
    bounty: run.modifiers.bountyOnPlayer,
    status: run.status,
    objectives: run.objectives.map((o) => ({
      label: o.label,
      detail: o.detail,
      progress: o.progress,
      status: o.status,
      optional: o.optional,
    })),
    announcements: radio.map((r) => r.text),
  };
}

export function ScrapstormApp() {
  const [enginePct, setEnginePct] = useState(0);
  const [engineMsg, setEngineMsg] = useState("Warming engines…");
  const [kit, setKit] = useState<EngineKit | null>(null);
  const [name, setName] = useState(() => loadName());
  const [shellClass, setShellClass] = useState<VehicleClassId>(() => loadClass());
  const [shellTrack, setShellTrack] = useState<TrackId>(() => loadTrack());
  const [shellPhase, setShellPhase] = useState<MatchPhase>("menu");
  const [menuState, setMenuState] = useState<SimState | null>(() =>
    makeShellState(loadName(), loadClass(), loadTrack(), "menu"),
  );
  const [hud, setHud] = useState<HudSlice | null>(null);
  const [meta, setMeta] = useState<MetaState>(() => loadMeta());
  const [canvasReady, setCanvasReady] = useState(false);
  const [pendingRace, setPendingRace] = useState(false);
  const simRef = useRef<GameSimulation | null>(null);
  const inputRef = useRef<InputController | null>(null);
  const kitRef = useRef<EngineKit | null>(null);
  const hudTick = useRef(0);
  const rewardApplied = useRef(false);
  const lastHit = useRef(999);
  const lastBoost = useRef(0);
  const [sceneEpoch, setSceneEpoch] = useState(0);
  const lastHudSig = useRef("");
  const bootGen = useRef(0);
  const prefs = useRef({ name: loadName(), classId: loadClass(), trackId: loadTrack() });
  const [ghostOn, setGhostOn] = useState(() => loadGhostOn());
  const shellPhaseRef = useRef<MatchPhase>("menu");

  /* ── career ────────────────────────────────────────────────────────────
   *
   * The live career is held in a REF as well as in state. refreshHud is a
   * useCallback wired into the render loop and would otherwise close over a
   * stale snapshot for the whole session — which is exactly the sort of bug
   * that shows up as "the last race paid nothing" three hours in.
   */
  const [career, setCareer] = useState<CareerState>(() => loadCareer());
  const careerRef = useRef<CareerState>(career);
  const commitCareer = useCallback((next: CareerState) => {
    careerRef.current = next;
    saveCareer(next);
    setCareer(next);
  }, []);
  const [careerView, setCareerView] = useState<"board" | "brief" | null>(null);
  const [briefId, setBriefId] = useState<string | null>(null);
  const runRef = useRef<MissionRun | null>(null);
  const missionDefRef = useRef<MissionDef | null>(null);
  const radioRef = useRef<{ text: string; until: number }[]>([]);
  const [missionResult, setMissionResult] = useState<{
    def: MissionDef;
    summary: MissionRunSummary;
    award: CareerAward;
  } | null>(null);
  const [beatQueue, setBeatQueue] = useState<string[]>([]);
  /** What to do once the current run of story beats has been read. */
  const afterBeats = useRef<(() => void) | null>(null);

  const refreshHud = useCallback(() => {
    const sim = simRef.current;
    const k = kitRef.current;
    if (!sim || !k) return;
    hudTick.current += 1;
    const phase = sim.state.phase;
    const racing =
      phase === "racing" || phase === "countdown" || phase === "paused";
    const every = racing ? 3 : 6;
    if (hudTick.current % every !== 0) return;

    /*
     * Mission tick.
     *
     * Safe at this reduced rate — and safe at ANY rate — because stepMission
     * takes its clock from sim.state.raceTime rather than from a dt we pass in.
     * A dropped frame, a pause, hitstop and a 144Hz monitor all produce the same
     * survival timer, and ticking twice in one frame cannot double-count.
     */
    const run = runRef.current;
    if (run) {
      applyMissionEffects(sim.state, stepMission(run, sim.state));
      const now = sim.state.raceTime;
      if (run.announcements.length > 0) {
        for (const line of run.announcements) {
          radioRef.current.push({ text: line, until: now + RADIO_HOLD });
        }
        run.announcements.length = 0;
      }
      radioRef.current = radioRef.current.filter((r) => r.until > now).slice(-3);
      /*
       * Throw the flag when the run is decided.
       *
       * A survival mission is authored with a lap count chosen only to outlast
       * its own clock — The Gauntlet is six laps for a two-minute objective.
       * Without this the player wins at 2:00 and then drives four more laps of
       * a race that no longer has a result in it.
       */
      if (
        run.resolvedAt !== null &&
        sim.state.phase === "racing" &&
        now >= run.resolvedAt + RESOLVE_GRACE
      ) {
        sim.state.phase = "finished";
      }
    }

    const missionHud = run ? missionHudFrom(run, radioRef.current) : null;

    if (racing) {
      const next = k.snapshotHud(sim.state, missionHud);
      const objSig = run
        ? run.objectives.map((o) => `${o.status}${o.detail}`).join(",")
        : "";
      const sig = `${next.phase}|${Math.round(next.raceTime * 10)}|${Math.round(next.player?.speed ?? 0)}|${Math.round(next.player?.health ?? 0)}|${Math.round((next.player?.uiAccel ?? 0) * 5)}|${next.player?.position}|${Math.ceil(next.countdown)}|${next.events[0]?.message ?? ""}|${objSig}|${radioRef.current.length}`;
      if (sig !== lastHudSig.current) {
        lastHudSig.current = sig;
        setHud(next);
      }
      if (phase === "paused") setMenuState(snapshotMenu(sim.state));
    } else {
      setMenuState(snapshotMenu(sim.state));
      setHud(k.snapshotHud(sim.state, missionHud));
    }

    const player = sim.state.vehicles.find((v) => v.isPlayer);
    if (player) {
      if (player.health < lastHit.current - 4) haptic("hit");
      lastHit.current = player.health;
      if (player.boostTimer > 0.5 && lastBoost.current <= 0.5) haptic("boost");
      lastBoost.current = player.boostTimer;
    }
    if (sim.state.phase === "finished" && !rewardApplied.current) {
      rewardApplied.current = true;
      const def = missionDefRef.current;
      if (run && def) {
        /*
         * One last step before summarising. The flag can fall on a frame the
         * interpreter has not seen — sim.fixedStep sets phase to "finished"
         * itself two seconds after the player crosses the line — and objectives
         * that only resolve at raceOver would otherwise still read "pending"
         * and fail a run the player actually won.
         */
        stepMission(run, sim.state);
        const summary = summarise(run, sim.state);
        const { career: nextCareer, award } = applyMissionResult(
          careerRef.current,
          def,
          summary,
        );
        // Career owes the scrap; meta.ts holds it. Drain and pay in one place so
        // the two can never disagree about what was earned.
        const drained = drainScrap(nextCareer);
        commitCareer(drained.career);
        const paid = applyMissionMeta(loadMeta(), {
          scrap: drained.scrap,
          place: summary.place,
          raceTimeSec: sim.state.raceTime,
          bestLap: summary.bestLap,
          won: summary.outcome === "complete",
        });
        saveMeta(paid);
        setMeta(paid);
        sim.state.scrapEarned = drained.scrap;
        /*
         * The result clip plays BEFORE the results card, not behind it.
         *
         * Both want the screen, and a card over a video is a composite nobody
         * designed. Holding the card until the clip finishes also means the
         * skip path and the natural end land in the same place — the card —
         * which is what stops a skipped victory from feeling like a bug.
         *
         * A mission is won when its objectives resolved complete — which is
         * NOT the same as finishing first, since a survival or escort run can
         * be won from any place. Neither clip is a one-shot: winning and losing
         * are the two things that happen most.
         */
        playCutscene(summary.outcome === "complete" ? "victory" : "defeat", () => {
          setMissionResult({ def, summary, award });
        });
        if (award.beats.length > 0) setBeatQueue(award.beats);
        // The world goes back to free play immediately; the results screen is
        // reading a snapshot, not a live directive.
        disarmMission();
        runRef.current = null;
        radioRef.current = [];
        haptic(summary.outcome === "complete" ? "boost" : "hit");
      } else {
        const place =
          sim.state.finishedOrder.indexOf(sim.state.playerId) + 1 ||
          sim.state.vehicles.length;
        const before = loadMeta();
        const { meta: next, earned } = applyRaceReward(
          before,
          place,
          sim.state.vehicles.length,
          sim.state.raceTime,
          sim.state.bestLapThisRace,
        );
        saveMeta(next);
        setMeta(next);
        sim.state.scrapEarned = earned;
      }
      setMenuState(snapshotMenu(sim.state));
    }
    if (sim.worldEpoch !== sceneEpoch) setSceneEpoch(sim.worldEpoch);
  }, [sceneEpoch, commitCareer]);

  useEffect(() => {
    const gen = ++bootGen.current;
    void (async () => {
      try {
        const loaded = await loadEngine((pct, msg) => {
          if (bootGen.current !== gen) return;
          setEnginePct(pct);
          setEngineMsg(msg);
        });
        if (bootGen.current !== gen) return;

        kitRef.current = loaded;
        const p = prefs.current;
        const sim = new loaded.GameSimulation(p.name, p.classId, p.trackId);
        const input = new loaded.InputController();
        sim.ghostEnabled = loadGhostOn();
        sim.setGuest(p.name, p.classId);
        sim.setTrack(p.trackId);
        if (shellPhaseRef.current === "garage") sim.setPhase("garage");

        simRef.current = sim;
        inputRef.current = input;
        loaded.wireControlsTest(sim, input);
        loaded.installAudioUnlock();

        (
          window as unknown as { __scrapstorm?: Record<string, unknown> }
        ).__scrapstorm = {
          getState: () => sim.state,
          /*
           * Deliberately NOT gated, and deliberately closing any gate it finds.
           *
           * QA drives this to get to a racing frame in a bounded number of
           * steps; a probe that has to poll a loading screen for an
           * unpredictable number of seconds is a probe that intermittently times
           * out. The cost is that a QA-started race is the one path that still
           * builds its world under a live countdown — which is fine, because
           * nobody is looking at the first three seconds of it.
           */
          startRace: () => {
            closeRaceGate("QA startRace");
            loaded.audioEngine.unlock();
            loaded.audioEngine.playUi("confirm");
            sim.setGuest(sim.state.guestName, sim.state.selectedClass);
            sim.setPhase("countdown");
            setSceneEpoch(sim.worldEpoch);
          },
          /**
           * QA hook. Mutating `getState().phase` only moves the sim — the
           * React shell keeps its own phase, so the garage/showcase scene
           * never mounts and captures come back empty. Drive both.
           */
          setPhase: (p: MatchPhase) => {
            // Same reasoning as startRace: a held gate freezes the sim clock,
            // and a QA hook that silently did nothing would be worse than one
            // that skips the warm-up.
            closeRaceGate("QA setPhase");
            shellPhaseRef.current = p;
            setShellPhase(p);
            sim.setPhase(p);
            setSceneEpoch(sim.worldEpoch);
            setMenuState(snapshotMenu(sim.state));
          },
          pause: () => sim.togglePause(),
          resume: () => sim.resume(),
          restart: () => {
            closeRaceGate("QA restart");
            sim.restartRace();
            setSceneEpoch(sim.worldEpoch);
          },
        };

        setMenuState(snapshotMenu(sim.state));
        setHud(loaded.snapshotHud(sim.state));
        setSceneEpoch(sim.worldEpoch);
        setKit(loaded);
        setEnginePct(100);
        requestAnimationFrame(() => {
          if (bootGen.current === gen) setCanvasReady(true);
        });
      } catch (e) {
        console.error("[boot]", e);
        setEngineMsg(
          e instanceof Error ? e.message : "Engine failed to load",
        );
      }
    })();
    return () => {
      bootGen.current += 1;
      inputRef.current?.dispose?.();
      // The gate is module state and outlives this component. A hot reload or a
      // route change mid-load would otherwise leave the next mount's sim frozen
      // until a watchdog nobody is watching fires.
      closeRaceGate("app unmounted");
      delete (window as unknown as { __controlsTest?: unknown }).__controlsTest;
      delete (window as unknown as { __scrapstorm?: unknown }).__scrapstorm;
    };
  }, []);

  useEffect(() => {
    if (!pendingRace || !kit || !simRef.current) return;
    setPendingRace(false);
    /*
     * The free-play button pressed before the engine finished loading.
     *
     * This used to build its own countdown inline, which made it the ONE path
     * into a race that skipped the asset load entirely — on the coldest cache in
     * the session, since the player had not even reached the garage. Routing it
     * through beginRace means the deferred start gets the same gate as every
     * other, including clearing any armed mission (beginRace's own null branch
     * does that).
     */
    beginRace(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingRace, kit]);

  const audio = () => kitRef.current?.audioEngine;

  const onName = (n: string) => {
    setName(n);
    prefs.current.name = n;
    localStorage.setItem("scrapstorm-name", n);
    simRef.current?.setGuest(n, prefs.current.classId);
    if (!simRef.current) {
      setMenuState(makeShellState(n, shellClass, shellTrack, shellPhase));
    } else {
      setSceneEpoch(simRef.current.worldEpoch);
      refreshHud();
    }
  };

  const onClass = (c: VehicleClassId) => {
    setShellClass(c);
    prefs.current.classId = c;
    localStorage.setItem("scrapstorm-class", c);
    simRef.current?.setGuest(prefs.current.name, c);
    audio()?.unlock();
    audio()?.playUi("click");
    haptic("ui");
    if (!simRef.current) {
      setMenuState(makeShellState(name, c, shellTrack, shellPhase));
    } else {
      setSceneEpoch(simRef.current.worldEpoch);
      refreshHud();
    }
  };

  const onTrack = (t: TrackId) => {
    setShellTrack(t);
    prefs.current.trackId = t;
    localStorage.setItem("scrapstorm-track", t);
    simRef.current?.setTrack(t);
    audio()?.unlock();
    audio()?.playUi("click");
    haptic("ui");
    if (!simRef.current) {
      setMenuState(makeShellState(name, shellClass, t, shellPhase));
    } else {
      setSceneEpoch(simRef.current.worldEpoch);
      refreshHud();
    }
  };

  const onSelectPaint = (paintId: string) => {
    const classId = prefs.current.classId;
    const next = selectPaint(loadMeta(), classId, paintId);
    saveMeta(next);
    setMeta(next);
    const hex = paintHex(classId, paintId, VEHICLE_CLASSES[classId].color);
    simRef.current?.applyPaintColor(hex);
    audio()?.playUi("click");
    haptic("tap");
    refreshHud();
  };

  const onUnlockPaint = (paintId: string) => {
    const cur = loadMeta();
    const next = tryUnlockPaint(cur, paintId);
    if (!next) {
      audio()?.playUi("click");
      return;
    }
    saveMeta(next);
    setMeta(next);
    const classId = prefs.current.classId;
    const equipped = selectPaint(next, classId, paintId);
    saveMeta(equipped);
    setMeta(equipped);
    const hex = paintHex(classId, paintId, VEHICLE_CLASSES[classId].color);
    simRef.current?.applyPaintColor(hex);
    audio()?.playUi("confirm");
    haptic("boost");
    refreshHud();
  };

  const onStartGarage = () => {
    setShellPhase("garage");
    shellPhaseRef.current = "garage";
    audio()?.unlock();
    audio()?.playUi("click");
    haptic("ui");
    if (simRef.current) {
      simRef.current.setPhase("garage");
      setSceneEpoch(simRef.current.worldEpoch);
      refreshHud();
    } else {
      setMenuState(makeShellState(name, shellClass, shellTrack, "garage"));
    }
  };

  /**
   * Put a race on the track. `def` null is a free-play heat.
   *
   * The ORDER inside the `.finally` is the load-bearing part and the reason the
   * mission arming does not happen earlier: sim.buildField reads BOT_NAMES when
   * the grid is constructed, which is inside startCountdown. Arm after the
   * assets are ready and immediately before the countdown, or the grid is named
   * after the previous race.
   */
  /*
   * The clip currently on screen, and what happens when it finishes.
   *
   * A single slot rather than a queue: two cutscenes wanting the screen at once
   * is a design mistake, not a case to handle, and a queue would quietly hide
   * it. The continuation is stored WITH the clip so a skip and a natural end
   * take exactly the same path — the commonest cutscene bug is a skip that
   * forgets to do what the clip was covering for.
   */
  const [cutscene, setCutscene] = useState<{
    id: CutsceneId;
    then: () => void;
  } | null>(null);

  const playCutscene = useCallback((id: CutsceneId, then: () => void) => {
    if (hasSeenCutscene(id)) {
      then();
      return;
    }
    setCutscene({ id, then });
  }, []);

  const beginRace = useCallback(
    (def: MissionDef | null) => {
      haptic("boost");
      const sim = simRef.current;
      const k = kitRef.current;
      if (!sim || !k) {
        setPendingRace(true);
        setEngineMsg("Spooling race…");
        return;
      }
      // The stake is taken once per ATTEMPT, at the grid. A mid-race restart is
      // the same attempt continuing — you never banked a result — so it is not
      // charged again; the retry button on the results screen comes back
      // through here and is.
      if (def) {
        const cost = missionCost(def);
        if (cost > 0) {
          const m = loadMeta();
          if (m.scrap < cost) return;
          const spent = spendScrap(m, cost);
          saveMeta(spent);
          setMeta(spent);
        }
      }
      setMissionResult(null);
      setCareerView(null);
      k.audioEngine.unlock();
      k.audioEngine.playUi("confirm");
      sim.setGuest(prefs.current.name, prefs.current.classId);
      sim.setTrack(def ? def.trackId : prefs.current.trackId);

      /*
       * TAKE THE GRID.
       *
       * Two distinct waits happen behind this one loading screen, and the order
       * is the whole point:
       *
       *  1. Everything fetchable is fetched and decoded, and the terrain field
       *     is baked. Nothing is on screen yet but the garage.
       *  2. Only THEN does the phase go to "countdown", which is what mounts the
       *     race world — the terrain mesh, the road ribbon, the scatter fields,
       *     the set-piece colliders, the prop pools, the post chain. That mount
       *     used to happen with the clock already running, which is why the
       *     first seconds of every race hitched.
       *
       * `openRaceGate` freezes the sim clock for both, so the lights sit on
       * three until `WorldWarmup` inside the scene says the frame has stopped
       * changing. See raceGate.ts — every phase of this is on a watchdog, so a
       * failed asset costs a slower start and never a race that will not begin.
       */
      const gen = openRaceGate({ assets: true });
      void k
        .prepareRaceAssets((pct, label) => setAssetProgress(pct / 100, label))
        .finally(() => {
          if (simRef.current !== sim) {
            // Menu changed under us — the gate belongs to a race that is not
            // happening, and leaving it held would freeze the next one.
            closeRaceGate("race abandoned during load");
            return;
          }
          /*
           * A second race was started while this one was still loading (retry
           * hammered on the results screen, or a mission picked mid-load). The
           * later call already owns the gate; this one must not put a countdown
           * on the board or it would arm a mission the player did not choose.
           */
          if (getRaceGate().generation !== gen) return;
          beginWorldWarm();
          if (def) {
            const c = careerRef.current;
            runRef.current = armMission(def, {
              heatFloor: heatNormalised(c) * 0.75,
              fieldPace: fieldPace(c),
            });
            // Missions own their distance. setTrack has just reset lapCount to
            // the circuit default, so this must come after it.
            sim.state.lapCount = def.laps;
            missionDefRef.current = def;
          } else {
            disarmMission();
            runRef.current = null;
            missionDefRef.current = null;
          }
          radioRef.current = [];
          /*
           * The cold open plays BEFORE the countdown starts, not over it.
           *
           * The world mount is triggered by the phase flip to "countdown" (see
           * raceGate), so a clip played after it would be covering a countdown
           * that is already running down — the player would skip it and find
           * the lights on 1. Held here, the clip is dead time the race has not
           * begun yet, which is exactly what a cold open is for. It is a
           * one-shot, so hasSeenCutscene short-circuits it on every later race.
           */
          playCutscene("cold-open", () => {
            sim.setPhase("countdown");
          });
          lastHit.current = 999;
          rewardApplied.current = false;
          lastHudSig.current = "";
          setSceneEpoch(sim.worldEpoch);
          setMenuState(snapshotMenu(sim.state));
          setHud(
            k.snapshotHud(
              sim.state,
              runRef.current ? missionHudFrom(runRef.current, []) : null,
            ),
          );
        });
    },
    [],
  );

  const onStartRace = () => beginRace(null);

  /* ── career navigation ─────────────────────────────────────────────── */

  const onOpenCareer = () => {
    audio()?.unlock();
    audio()?.playUi("click");
    setMissionResult(null);
    setCareerView("board");
  };

  const onSelectMission = (id: string) => {
    audio()?.playUi("click");
    setBriefId(id);
    setCareerView("brief");
  };

  /**
   * Roll out, via the intro beat if there is one.
   *
   * The beat is queued rather than shown inline so that the same machinery
   * handles the two-to-three beats an aftermath can produce. `afterBeats` is
   * what turns "read this" back into "now drive".
   */
  const onRollOut = () => {
    const def = briefId ? missionById(briefId) : null;
    if (!def) return;
    const intro = pendingIntroBeat(careerRef.current, def);
    if (intro) {
      commitCareer(markBeatSeen(careerRef.current, intro));
      afterBeats.current = () => beginRace(def);
      setBeatQueue([intro]);
      return;
    }
    beginRace(def);
  };

  const onDismissBeat = () => {
    audio()?.playUi("click");
    // The continuation runs OUTSIDE the state updater. React may invoke an
    // updater twice (StrictMode does, deliberately), and a double-invoked
    // `beginRace` starts two countdowns and charges the stake twice.
    const rest = beatQueue.slice(1);
    setBeatQueue(rest);
    if (rest.length === 0) {
      const done = afterBeats.current;
      afterBeats.current = null;
      done?.();
    }
  };

  const onLeaveMission = () => {
    disarmMission();
    runRef.current = null;
    missionDefRef.current = null;
    radioRef.current = [];
    setMissionResult(null);
    setCareerView("board");
    setShellPhase("menu");
    shellPhaseRef.current = "menu";
    simRef.current?.setPhase("menu");
    if (simRef.current) setSceneEpoch(simRef.current.worldEpoch);
    refreshHud();
  };

  const onResetCareer = () => {
    if (typeof window !== "undefined" && !window.confirm("Wipe the career and start again?")) {
      return;
    }
    disarmMission();
    runRef.current = null;
    missionDefRef.current = null;
    commitCareer(resetCareer());
    setMissionResult(null);
    setCareerView("board");
  };

  const onGhostToggle = useCallback((on: boolean) => {
    setGhostOn(on);
    try {
      localStorage.setItem("scrapstorm-ghost", on ? "1" : "0");
    } catch {
      /* private mode */
    }
    const sim = simRef.current;
    if (sim) {
      sim.ghostEnabled = on;
      // Re-resolve immediately so the garage reflects the choice without a
      // race restart.
      sim.setTrack(sim.state.selectedTrack);
      setSceneEpoch(sim.worldEpoch);
    }
  }, []);

  const onBackMenu = () => {
    // Free play must never inherit the last mission's manhunt, its named grid or
    // its lap count. Leaving by any door disarms.
    if (runRef.current || missionDefRef.current) {
      disarmMission();
      runRef.current = null;
      missionDefRef.current = null;
      radioRef.current = [];
      setCareerView("board");
    }
    setMissionResult(null);
    setShellPhase("menu");
    shellPhaseRef.current = "menu";
    audio()?.playUi("click");
    haptic("ui");
    if (simRef.current) {
      simRef.current.setPhase("menu");
      setSceneEpoch(simRef.current.worldEpoch);
      refreshHud();
    } else {
      setMenuState(makeShellState(name, shellClass, shellTrack, "menu"));
    }
  };

  // Free-play "race again" only. A mission run replays through the results
  // screen, which goes back through beginRace so the stake is charged again.
  const onReplay = () => beginRace(null);

  const onPause = useCallback(() => {
    simRef.current?.togglePause();
    refreshHud();
  }, [refreshHud]);

  const onResume = () => {
    simRef.current?.resume();
    refreshHud();
  };

  const onRestart = () => {
    audio()?.playUi("confirm");
    rewardApplied.current = false;
    lastHudSig.current = "";
    // Re-arm before the grid is rebuilt, not after: restartRace goes straight
    // into startCountdown, which reads the roster while building the field. A
    // fresh MissionRun is required too — the old one carries a whole race worth
    // of bookkeeping, including who it has already credited you for wrecking.
    const def = missionDefRef.current;
    if (def && simRef.current) {
      const c = careerRef.current;
      runRef.current = armMission(def, {
        heatFloor: heatNormalised(c) * 0.75,
        fieldPace: fieldPace(c),
      });
      simRef.current.state.lapCount = def.laps;
      radioRef.current = [];
    }
    /*
     * A restart is a race start, and it rebuilds just as much world.
     *
     * `restartRace` bumps worldEpoch, which changes the scene key, which tears
     * down and remounts the entire race tree — terrain mesh, road ribbon,
     * scatter fields, prop pools, post chain. All of it landed on the countdown
     * exactly as a first race did. Nothing needs downloading this time, so the
     * gate opens straight into the warm phase: typically a second or so, mostly
     * geometry re-upload.
     */
    openRaceGate({ assets: false });
    simRef.current?.restartRace();
    setSceneEpoch(simRef.current?.worldEpoch ?? 0);
    refreshHud();
  };

  const overlayState =
    menuState ?? makeShellState(name, shellClass, shellTrack, shellPhase);
  const livePhase = simRef.current?.state.phase ?? shellPhase;
  const scenePhase = livePhase;

  const displayState =
    simRef.current &&
    (livePhase === "racing" ||
      livePhase === "countdown" ||
      livePhase === "paused" ||
      livePhase === "finished")
      ? {
          ...overlayState,
          phase: livePhase,
          selectedClass: simRef.current.state.selectedClass,
          selectedTrack: simRef.current.state.selectedTrack,
        }
      : {
          ...overlayState,
          phase:
            livePhase === "garage" || shellPhase === "garage"
              ? ("garage" as const)
              : overlayState.phase,
          selectedClass: shellClass,
          selectedTrack: shellTrack,
        };

  const inRace =
    livePhase === "racing" || livePhase === "countdown" || livePhase === "paused";
  const briefDef = briefId ? (missionById(briefId) ?? null) : null;
  // While any career panel owns the screen the ordinary menu must not also be
  // mounted — two full-screen overlays means invisible buttons.
  const careerOverlay =
    !!missionResult ||
    (careerView === "brief" && !!briefDef) ||
    (careerView === "board" && !inRace);

  const GameCanvas = kit?.GameCanvas;
  const GameHUD = kit?.GameHUD;
  const MobileControls = kit?.MobileControls;
  const GraphicsDebug = kit?.GraphicsDebug;
  const engineReady = !!kit && !!simRef.current && !!inputRef.current;

  return (
    <div className="relative h-dvh w-full overflow-hidden bg-[#0c0a09] text-fg">
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 80% 55% at 70% 18%, rgba(234,88,12,0.2), transparent 55%), radial-gradient(ellipse 55% 45% at 12% 85%, rgba(45,212,191,0.1), transparent 50%), linear-gradient(180deg, #1c1410 0%, #0c0a09 60%)",
        }}
      />

      {engineReady && canvasReady && GameCanvas && simRef.current && inputRef.current ? (
        <GameCanvas
          sim={simRef.current}
          input={inputRef.current}
          onHud={refreshHud}
          onPauseToggle={onPause}
          sceneKey={`w${sceneEpoch}-${prefs.current.classId}-${prefs.current.trackId}`}
        />
      ) : null}

      {/*
        Menu and garage backdrops. Behind the vignette and every overlay, and
        never mounted during a race — a decoded 7 MB video decoding alongside
        the render loop is main-thread cost for something nobody is looking at.
        CutsceneLoop fails silently, so a missing file yields a plain menu
        rather than a broken one.
      */}
      {!inRace && (shellPhase === "menu" || shellPhase === "garage") && (
        <CutsceneLoop
          id={shellPhase === "garage" ? "garage" : "menu-loop"}
          opacity={0.4}
        />
      )}

      <div className="pointer-events-none absolute inset-0 z-10 bg-[radial-gradient(ellipse_at_center,transparent_40%,rgba(10,10,11,0.55)_100%)]" />

      {!careerOverlay && (
        <MenuOverlay
          state={displayState}
          name={name}
          meta={meta}
          career={career}
          onName={onName}
          onClass={onClass}
          onTrack={onTrack}
          onStartGarage={onStartGarage}
          onStartRace={onStartRace}
          onCareer={onOpenCareer}
          onBackMenu={onBackMenu}
          onReplay={onReplay}
          onResume={onResume}
          onRestart={onRestart}
          onSelectPaint={onSelectPaint}
          onUnlockPaint={onUnlockPaint}
          ghostOn={ghostOn}
          onGhostToggle={onGhostToggle}
        />
      )}

      {/*
        Career screens sit above the menu overlay and replace it entirely while
        open. Rendering both would leave the garage's pointer targets live
        underneath a full-screen panel.
      */}
      {/*
        Above every other layer, including the pause menu and the results card.
        A cutscene that something else can draw over is worse than no cutscene:
        the player sees a broken composite rather than a beat.
      */}
      {cutscene && (
        <Cutscene
          id={cutscene.id}
          onDone={() => {
            const go = cutscene.then;
            setCutscene(null);
            go();
          }}
        />
      )}

      {missionResult ? (
        <MissionResults
          def={missionResult.def}
          summary={missionResult.summary}
          award={missionResult.award}
          onRetry={() => beginRace(missionResult.def)}
          onBoard={onLeaveMission}
        />
      ) : careerView === "brief" && briefDef ? (
        <MissionBrief
          def={briefDef}
          career={career}
          meta={meta}
          classId={shellClass}
          onClass={onClass}
          onStart={onRollOut}
          onBack={() => setCareerView("board")}
        />
      ) : careerView === "board" && !inRace ? (
        <CareerBoard
          career={career}
          meta={meta}
          onSelect={onSelectMission}
          onClose={() => setCareerView(null)}
          onReset={onResetCareer}
        />
      ) : null}

      {beatQueue.length > 0 && (
        <StoryCard
          beatId={beatQueue[0]!}
          remaining={beatQueue.length}
          onNext={onDismissBeat}
        />
      )}

      {/*
        Subscribes to the race gate directly rather than taking props: the gate
        is written from three places (this file, prepareRaceAssets and the
        in-scene WorldWarmup driver) and routing all of that back up through
        React state would re-render the whole shell — including the canvas
        wrapper — several times a second during a load.
      */}
      <RaceLoadingScreen />

      {hud && GameHUD ? <GameHUD hud={hud} onPause={onPause} /> : null}
      {GraphicsDebug ? <GraphicsDebug phase={scenePhase} /> : null}
      {kit?.FpsMeter ? <kit.FpsMeter phase={scenePhase} /> : null}
      {MobileControls && inputRef.current ? (
        <MobileControls
          input={inputRef.current}
          phase={scenePhase}
          onPause={onPause}
        />
      ) : null}

      {!engineReady && (
        <div className="pointer-events-none absolute bottom-4 left-4 right-4 z-50 mx-auto max-w-sm sm:left-auto sm:right-6 sm:mx-0">
          <div className="rounded-lg border border-white/10 bg-black/50 px-3 py-2 backdrop-blur-sm">
            <div className="mb-1 flex justify-between text-[0.65rem] text-[#a8a29e]">
              <span>{pendingRace ? "Starting race…" : engineMsg}</span>
              <span>{Math.round(enginePct)}%</span>
            </div>
            <div className="h-1 overflow-hidden rounded-full bg-[#292524]">
              <div
                className="h-full rounded-full bg-gradient-to-r from-teal-400 to-orange-400 transition-[width] duration-200"
                style={{ width: `${Math.min(100, enginePct)}%` }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
