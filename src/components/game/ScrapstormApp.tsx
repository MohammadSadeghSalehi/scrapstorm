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
  applyRaceReward,
  loadMeta,
  paintHex,
  saveMeta,
  selectPaint,
  tryUnlockPaint,
  type MetaState,
} from "@/game/meta";
import { haptic } from "@/game/haptics";
import { MenuOverlay } from "./Menus";
import type { HudSlice } from "./GameHUD";

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
  snapshotHud: (s: SimState) => HudSlice;
  GameHUD: ComponentType<{ hud: HudSlice; onPause: () => void }>;
  MobileControls: ComponentType<{
    input: InputController;
    phase: MatchPhase;
    onPause: () => void;
  }>;
  GraphicsDebug: ComponentType<{ phase: string }>;
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
  const shellPhaseRef = useRef<MatchPhase>("menu");

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

    if (racing) {
      const next = k.snapshotHud(sim.state);
      const sig = `${next.phase}|${Math.round(next.raceTime * 10)}|${Math.round(next.player?.speed ?? 0)}|${Math.round(next.player?.health ?? 0)}|${Math.round((next.player?.uiAccel ?? 0) * 5)}|${next.player?.position}|${Math.ceil(next.countdown)}|${next.events[0]?.message ?? ""}`;
      if (sig !== lastHudSig.current) {
        lastHudSig.current = sig;
        setHud(next);
      }
      if (phase === "paused") setMenuState(snapshotMenu(sim.state));
    } else {
      setMenuState(snapshotMenu(sim.state));
      setHud(k.snapshotHud(sim.state));
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
      setMenuState(snapshotMenu(sim.state));
    }
    if (sim.worldEpoch !== sceneEpoch) setSceneEpoch(sim.worldEpoch);
  }, [sceneEpoch]);

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
          startRace: () => {
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
            shellPhaseRef.current = p;
            setShellPhase(p);
            sim.setPhase(p);
            setSceneEpoch(sim.worldEpoch);
            setMenuState(snapshotMenu(sim.state));
          },
          pause: () => sim.togglePause(),
          resume: () => sim.resume(),
          restart: () => {
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
      delete (window as unknown as { __controlsTest?: unknown }).__controlsTest;
      delete (window as unknown as { __scrapstorm?: unknown }).__scrapstorm;
    };
  }, []);

  useEffect(() => {
    if (!pendingRace || !kit || !simRef.current) return;
    setPendingRace(false);
    const sim = simRef.current;
    kit.audioEngine.unlock();
    kit.audioEngine.playUi("confirm");
    sim.setGuest(prefs.current.name, prefs.current.classId);
    sim.setTrack(prefs.current.trackId);
    sim.setPhase("countdown");
    lastHit.current = 999;
    rewardApplied.current = false;
    lastHudSig.current = "";
    setSceneEpoch(sim.worldEpoch);
    setMenuState(snapshotMenu(sim.state));
    setHud(kit.snapshotHud(sim.state));
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

  const onStartRace = () => {
    haptic("boost");
    if (!simRef.current || !kitRef.current) {
      setPendingRace(true);
      setEngineMsg("Spooling race…");
      return;
    }
    const sim = simRef.current;
    const k = kitRef.current;
    k.audioEngine.unlock();
    k.audioEngine.playUi("confirm");
    sim.setGuest(prefs.current.name, prefs.current.classId);
    sim.setTrack(prefs.current.trackId);
    sim.setPhase("countdown");
    lastHit.current = 999;
    rewardApplied.current = false;
    lastHudSig.current = "";
    setSceneEpoch(sim.worldEpoch);
    setMenuState(snapshotMenu(sim.state));
    setHud(k.snapshotHud(sim.state));
  };

  const onBackMenu = () => {
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

  const onReplay = () => onStartRace();

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

      <div className="pointer-events-none absolute inset-0 z-10 bg-[radial-gradient(ellipse_at_center,transparent_40%,rgba(10,10,11,0.55)_100%)]" />

      <MenuOverlay
        state={displayState}
        name={name}
        meta={meta}
        onName={onName}
        onClass={onClass}
        onTrack={onTrack}
        onStartGarage={onStartGarage}
        onStartRace={onStartRace}
        onBackMenu={onBackMenu}
        onReplay={onReplay}
        onResume={onResume}
        onRestart={onRestart}
        onSelectPaint={onSelectPaint}
        onUnlockPaint={onUnlockPaint}
      />

      {hud && GameHUD ? <GameHUD hud={hud} onPause={onPause} /> : null}
      {GraphicsDebug ? <GraphicsDebug phase={scenePhase} /> : null}
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
