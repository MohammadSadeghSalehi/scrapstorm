/**
 * Weather — public API, the renderer-free half.
 *
 * `./RainCurtain` is deliberately NOT re-exported here. It imports three and
 * @react-three/fiber, and this index is on physics.ts's import path: pulling
 * the renderer in through a barrel file is how `GameSimulation` stops being
 * constructible headlessly, and it would take mission-smoke's 743 checks with
 * it. Import the component from `./weather/RainCurtain` directly, from the
 * render tree only.
 */
export * from "./conditions";
