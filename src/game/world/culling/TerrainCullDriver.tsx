/**
 * R3F driver: CPU cull dunes / scenery / ground tiles each frame.
 * Exposes last stats on window.__terrainCull for QA.
 */
import { useFrame, useThree } from "@react-three/fiber";
import { useRef } from "react";
import * as THREE from "three";
import {
  cullSpheres,
  cullConfigForTier,
  type CullSphere,
  type CullStats,
  type TerrainCullConfig,
} from "./cpuTerrainCull";
import { qualityManager } from "../quality";
import { FRAME } from "../framePriority";

type Listener = (visible: number[], stats: CullStats) => void;

/** Shared registry so DuneField / Scenery can subscribe without prop drilling. */
class TerrainCullBus {
  private spheres: CullSphere[] = [];
  private listeners = new Set<Listener>();
  private enabled = true;
  private lastVisible: number[] = [];
  private lastStats: CullStats = {
    tested: 0,
    frustumPass: 0,
    distancePass: 0,
    visible: 0,
    ms: 0,
  };
  private config: TerrainCullConfig = cullConfigForTier("medium");

  setSpheres(s: CullSphere[]) {
    this.spheres = s;
  }

  getSpheres() {
    return this.spheres;
  }

  setEnabled(on: boolean) {
    this.enabled = on;
  }

  isEnabled() {
    return this.enabled;
  }

  setConfig(c: TerrainCullConfig) {
    this.config = c;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  getLast() {
    return { visible: this.lastVisible, stats: this.lastStats };
  }

  tick(camera: THREE.Camera) {
    if (!this.enabled || this.spheres.length === 0) {
      this.lastVisible = this.spheres.map((_, i) => i);
      this.lastStats = {
        tested: this.spheres.length,
        frustumPass: this.spheres.length,
        distancePass: this.spheres.length,
        visible: this.spheres.length,
        ms: 0,
      };
    } else {
      const result = cullSpheres(this.spheres, camera, this.config);
      this.lastVisible = result.visible;
      this.lastStats = result.stats;
    }
    for (const l of this.listeners) l(this.lastVisible, this.lastStats);
  }
}

/** Named buses for independent prop classes */
export const duneCullBus = new TerrainCullBus();
export const sceneryCullBus = new TerrainCullBus();
export const groundCullBus = new TerrainCullBus();

export function TerrainCullDriver() {
  const { camera } = useThree();
  const frame = useRef(0);

  useFrame(() => {
    frame.current++;
    if (frame.current % 30 === 0) {
      const tier = qualityManager.get().tier;
      const cfg = cullConfigForTier(tier);
      duneCullBus.setConfig(cfg);
      sceneryCullBus.setConfig(cfg);
      groundCullBus.setConfig({
        ...cfg,
        maxDistance: cfg.maxDistance + 40,
      });
    }
    duneCullBus.tick(camera);
    sceneryCullBus.tick(camera);
    groundCullBus.tick(camera);

    if (typeof window !== "undefined" && frame.current % 15 === 0) {
      window.__terrainCull = {
        dunes: duneCullBus.getLast(),
        scenery: sceneryCullBus.getLast(),
        ground: groundCullBus.getLast(),
      };
    }
  }, FRAME.LATE);

  return null;
}
