# T01 — Meshopt GLBs render as the real mesh

The hero cars and weapons are Meshopt-compressed `.glb` files. A bare
`THREE.GLTFLoader` rejects them and the game keeps the placeholder primitive.

**Visible spec:** In the garage, the Interceptor is the rust-orange combat car
from the concept still, not a box or a capsule. Weapons on the roof are the
GLB racks, not untextured cylinders.

**Do not** read `benches/track-b.mjs`. Hidden tests check that loaders go
through `createGltfLoader()`.
