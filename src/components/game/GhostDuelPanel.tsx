import { useEffect, useState } from "react";
import { useP2PRoom } from "@/lib/multiplayer";
import {
  decodeGhostShare,
  encodeGhostShare,
  getRivalGhost,
  isGhostRun,
  localGhostForTrack,
  makeRoomCode,
  setRivalGhost,
  type GhostDuelMsg,
} from "@/game/ghostDuel";
import type { GhostRun } from "@/game/ghost";
import type { TrackId } from "@/game/track";
import { TRACK_DEFS } from "@/game/track";
import { audioEngine } from "@/game/audio/AudioEngine";

/**
 * Casual ghost duel: paste a share code, or join a P2P room to exchange ghosts.
 * Not competitive matchmaking — co-op only.
 */
export function GhostDuelPanel({
  trackId,
  name,
}: {
  trackId: TrackId;
  name: string;
}) {
  const [code, setCode] = useState("");
  const [status, setStatus] = useState("");
  const [roomCode, setRoomCode] = useState(() => makeRoomCode());
  const [p2pOn, setP2pOn] = useState(false);
  const [rival, setRival] = useState(getRivalGhost());
  const local = localGhostForTrack(trackId);

  const p2p = useP2PRoom({
    room: roomCode,
    name: name || "Racer",
    enabled: p2pOn,
  });

  useEffect(() => {
    if (!p2pOn) return;
    return p2p.onMessage((from, data) => {
      const msg = data as GhostDuelMsg;
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "hello") {
        setStatus(`Peer ${msg.name} joined — exchanging ghosts…`);
        if (local) {
          p2p.send({ type: "ghost", run: local }, from);
        }
      } else if (msg.type === "ghost" && isGhostRun(msg.run)) {
        setRivalGhost(msg.run);
        setRival(msg.run);
        setStatus(`Loaded rival ghost: ${msg.run.name} · ${msg.run.totalTime.toFixed(1)}s`);
        audioEngine.playUi("confirm");
        // reply with ours
        if (local) p2p.send({ type: "ghost", run: local }, from);
      }
    });
  }, [p2pOn, p2p, local]);

  useEffect(() => {
    if (!p2pOn || !p2p.joined) return;
    // announce presence
    p2p.send({ type: "hello", name: name || "Racer", trackId });
    if (local && p2p.peers.length > 0) {
      p2p.broadcast({ type: "ghost", run: local });
    }
  }, [p2pOn, p2p.joined, p2p.peers.length, local, name, trackId, p2p]);

  const onExport = () => {
    if (!local) {
      setStatus("No personal ghost on this circuit yet — finish a heat first.");
      return;
    }
    const share = encodeGhostShare(local);
    void navigator.clipboard?.writeText(share);
    setCode(share);
    setStatus("Ghost code copied — send it to a friend.");
    audioEngine.playUi("click");
  };

  const onImport = () => {
    const run = decodeGhostShare(code);
    if (!run) {
      setStatus("Invalid ghost code.");
      audioEngine.playUi("click");
      return;
    }
    setRivalGhost(run);
    setRival(run);
    setStatus(`Rival loaded: ${run.name} on ${TRACK_DEFS.find((d) => d.id === run.trackId)?.name ?? run.trackId}`);
    audioEngine.playUi("confirm");
  };

  const onClear = () => {
    setRivalGhost(null);
    setRival(null);
    setStatus("Rival ghost cleared.");
    audioEngine.playUi("click");
  };

  return (
    /* No border and no heading of its own: this panel now lives inside a
       disclosure that is already labelled "Ghost duel", and the old card drew a
       second box and a second title inside the first. */
    <div className="pt-1">
      {rival && (
        <p className="text-right text-[0.62rem] text-[var(--color-signal)]/85">
          Rival · {rival.totalTime.toFixed(1)}s
        </p>
      )}
      <p className="text-[0.68rem] leading-relaxed text-muted">
        Race a friend's ghost — paste a code or open a casual P2P room (not ranked).
      </p>

      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" className="btn-secondary !min-h-9 !px-3 !text-xs" onClick={onExport}>
          Export my ghost
        </button>
        <button type="button" className="btn-secondary !min-h-9 !px-3 !text-xs" onClick={onImport}>
          Import code
        </button>
        {rival && (
          <button type="button" className="btn-secondary !min-h-9 !px-3 !text-xs" onClick={onClear}>
            Clear rival
          </button>
        )}
      </div>

      <textarea
        className="mt-2 w-full resize-none rounded-sm border border-border bg-bg px-2.5 py-2 font-mono text-[0.65rem] text-fg outline-none ring-fg/20 focus:ring-2"
        rows={2}
        placeholder="Paste SSG1.… ghost code"
        value={code}
        onChange={(e) => setCode(e.target.value)}
      />

      <div className="mt-3 border-t border-border/60 pt-3">
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-[0.65rem] uppercase tracking-wider text-muted">
            Room
            <input
              className="ml-2 w-28 rounded-sm border border-border bg-bg px-2 py-1 font-mono text-xs text-fg uppercase outline-none"
              value={roomCode}
              onChange={(e) => setRoomCode(e.target.value.toUpperCase().slice(0, 12))}
              disabled={p2pOn}
            />
          </label>
          <button
            type="button"
            className={p2pOn ? "btn-primary !min-h-9 !px-3 !text-xs" : "btn-secondary !min-h-9 !px-3 !text-xs"}
            onClick={() => {
              setP2pOn((v) => !v);
              setStatus(p2pOn ? "Left room." : "Joining room…");
              audioEngine.playUi("click");
            }}
          >
            {p2pOn ? "Leave room" : "Open P2P room"}
          </button>
        </div>
        {p2pOn && (
          <p className="mt-1.5 text-[0.65rem] text-muted">
            {p2p.joined ? "Signaling live" : "Connecting…"} · peers {p2p.peers.length}
            {p2p.peers.map((p) => (
              <span key={p.id} className="ml-1 text-fg/80">
                {p.name || p.id.slice(0, 6)}
                {p.rttMs != null ? ` ${Math.round(p.rttMs)}ms` : ""}
              </span>
            ))}
          </p>
        )}
      </div>

      {status && <p className="mt-2 text-[0.7rem] text-fg/80">{status}</p>}
      {local && (
        <p className="mt-1 text-[0.65rem] text-muted">
          Your PB on {TRACK_DEFS.find((d) => d.id === trackId)?.name ?? trackId}: {local.totalTime.toFixed(2)}s
        </p>
      )}
    </div>
  );
}
