# Nanite investigation (browser Scrapstorm)

## What Unreal Nanite is
- Virtualized geometry: mesh split into clusters (~128 tris)
- GPU-driven visibility + continuous LOD (no discrete LOD pops)
- Streams only visible clusters; supports film-scale triangle counts

## Can we use it here?
**No** — Nanite is UE5-only. Three.js / WebGL2 / stock WebGPU have no Nanite runtime.

| Path | Verdict |
|------|---------|
| Embed UE Nanite | Impossible in browser app |
| Port Nanite to WebGPU | Research multi-year; not demo-scope |
| Meshopt + glTF LODs | Practical for static props |
| **Our hybrid** | Ship now |

## What we implemented (Nanite *spirit*)
1. **Vehicle mesh LoD bands** (`naniteLod.ts`) — hero / mid / far geometry sets
2. **GPU material detail LoD** — multi-band noise in fragment shader
3. **CPU terrain/prop cull** — frustum + distance + instance rebuild
4. **Adaptive quality** — drop bands on FPS pressure

## Recommendation
Stay on WebGL2 hybrid. Revisit cluster/meshlet rendering only when WebGPU mesh shaders are stable in production Three.js builds.
