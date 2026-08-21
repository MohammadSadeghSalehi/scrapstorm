# T03 — Walls you just broke do not keep hitting you

Set-piece walls are capsules. After a section is destroyed, driving through the
hole must not shove the car as if the wall were still there, and a query that
returns several modules must not all report the last module's contact.

**Visible spec:** Ram a barrier, punch a gap, drive the gap. The car goes
through. Nearby intact modules still stop you.

**Do not** stash the shared `contact` object from `capsuleContact` in an array
and read it later. Copy `nx`, `nz`, `pen` before the next call.
