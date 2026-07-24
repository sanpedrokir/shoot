"use client";

import { useEffect, useRef, useState } from "react";
import type { PresenceChannel } from "pusher-js";
import {
  MAX_PLAYERS,
  generateRoomCode,
  getClientId,
  subscribeToRoom,
  leaveRoom,
  type InputMessage,
  type StartMessage,
  type NetSnapshot,
} from "../lib/coop";
import AuthPanel, { type AuthUser } from "./AuthPanel";

type Bullet = { x: number; y: number; vy: number; ownerId: string };
type Missile = { x: number; y: number; vy: number; vx: number };
type Bomb = { x: number; y: number; vy: number; rot: number };
type Cash = { x: number; y: number; vy: number; phase: number };
type Enemy = {
  x: number;
  y: number;
  vy: number;
  phase: number;
  amp: number;
  scale: number;
  fireTimer: number;
  bombTimer: number;
};
type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  color: string;
};
type Cloud = { x: number; y: number; r: number; speed: number; opacity: number };

type Player = {
  id: string;
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  invuln: number;
  fireTimer: number;
};

type Status = "ready" | "playing" | "levelcomplete" | "gameover" | "quit";
type NetRole = "solo" | "host" | "ally";
type LobbyMode = "solo" | "host" | "join";
type ConnStatus = "idle" | "connecting" | "connected" | "error";

interface GameState {
  width: number;
  height: number;
  level: number;
  levelDuration: number;
  players: Player[];
  bullets: Bullet[];
  missiles: Missile[];
  bombs: Bomb[];
  enemies: Enemy[];
  cash: Cash[];
  particles: Particle[];
  clouds: Cloud[];
  spawnTimer: number;
  cashTimer: number;
  elapsed: number;
  pointerDown: boolean;
  keys: Set<string>;
}

const PLAYER_RADIUS = 14;
const ENEMY_RADIUS = 15;
// Hitboxes are smaller than the sprites so near-misses look and feel fair.
const PLAYER_HIT_RADIUS = 7;
const ENEMY_HIT_RADIUS = 10;
const MISSILE_HIT_RADIUS = 3.5;
const BOMB_HIT_RADIUS = 4.5;
// Wider than a hazard hit-radius on purpose — cash is a reward, not a
// threat, so near-misses while dodging should still count as a grab instead
// of demanding pixel-precise flying on top of everything else going on.
const CASH_HIT_RADIUS = 18;
const INVULN_TIME = 2.2;
// Each cash pickup is worth a fixed amount; once the running total crosses
// another multiple of CASH_PER_LIFE, one life is restored (capped at
// maxLives), so recovery is a steady drip rather than an instant refill.
const CASH_VALUE = 20;
const CASH_PER_LIFE = 40;

// A restored life also grants a brief "Healthy" invulnerability window, and
// that window grows the more total cash a run has collected — so staying
// cash-focused pays off with a longer safety margin each time you heal, not
// just an occasional extra life.
function healInvulnDuration(cashTotal: number) {
  return clamp(2 + cashTotal * 0.004, 2.5, 6);
}
const GRAVITY = 130;
// Pusher hard-caps client events at 10/sec per connection; staying well
// under that avoids events getting silently dropped (which reads as
// mounting lag that eventually "hangs" once updates stop arriving).
const BROADCAST_INTERVAL = 1 / 8;
const INPUT_SEND_INTERVAL = 1 / 8;
const MAX_SNAPSHOT_ENTITIES = 40;

// Difficulty grows with the log of the level so early stages ramp up fast
// while the long tail (toward level 1000 and beyond) keeps climbing but
// never explodes.
function levelDifficulty(level: number) {
  return Math.log2(level + 1) * 0.85;
}

// On top of level difficulty, a single playthrough gets tougher the longer
// you survive. This is a flat step, not a smooth curve: it holds steady for
// a full minute, then jumps by +4% — a continuous log-curve compounded too
// fast right before the time limit, spawning a flood of planes. Stepping by
// whole minutes keeps the ramp predictable, in solo, host, and ally games
// alike (ally sees it because the host is the one simulating and
// broadcasting it).
function timeDifficultyMultiplier(elapsed: number) {
  return 1 + Math.floor(elapsed / 60) * 0.04;
}

// Cash drops get more frequent the longer a run goes, mirroring the
// difficulty ramp so recovery keeps pace with the growing pressure — same
// flat-per-minute stepping, just shrinking the spawn interval instead of
// growing a difficulty score.
function cashRateMultiplier(elapsed: number) {
  return 1 + Math.floor(elapsed / 60) * 0.3;
}

// The run alternates between two flavors of pressure — a bomb barrage vs a
// squadron swarm — so survival never settles into one static pattern.
// Weights oscillate smoothly (sine-based) rather than hard-switching, and
// each spends roughly half the cycle near its peak with a soft crossfade
// through the middle.
const PHASE_PERIOD = 45;
function phaseFocus(elapsed: number) {
  const wave = Math.sin((elapsed / PHASE_PERIOD) * Math.PI * 2);
  return { bombFocus: Math.max(0, wave), swarmFocus: Math.max(0, -wave) };
}

// How long a level requires surviving to clear it: level 1 is a full 4
// minutes, growing slowly and capping so a long campaign stays a
// long-term goal rather than an ever-longer marathon.
function levelSurviveDuration(level: number) {
  return clamp(240 + (level - 1) * 4, 240, 360);
}

function makePlayers(width: number, height: number, playerIds: string[]): Player[] {
  const n = playerIds.length;
  return playerIds.map((id, i) => {
    const x = width / 2 + (i - (n - 1) / 2) * 56;
    const y = height - height * 0.16;
    return { id, x, y, targetX: x, targetY: y, invuln: 2, fireTimer: 0 };
  });
}

function makeInitialState(width: number, height: number, level: number, playerIds: string[]): GameState {
  const clouds: Cloud[] = Array.from({ length: 6 }, () => ({
    x: Math.random() * width,
    y: Math.random() * height,
    r: 22 + Math.random() * 34,
    speed: 12 + Math.random() * 18,
    opacity: 0.35 + Math.random() * 0.3,
  }));
  return {
    width,
    height,
    level,
    levelDuration: levelSurviveDuration(level),
    players: makePlayers(width, height, playerIds),
    bullets: [],
    missiles: [],
    bombs: [],
    enemies: [],
    cash: [],
    particles: [],
    clouds,
    spawnTimer: 0.6,
    cashTimer: 2 + Math.random() * 2,
    elapsed: 0,
    pointerDown: false,
    keys: new Set(),
  };
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

// Trims broadcast payload size (fewer JSON bytes per number) since Pusher
// client events are capped at 10KB each.
function round1(n: number) {
  return Math.round(n * 10) / 10;
}

function keyboardVector(keys: Set<string>): { kx: number; ky: number } {
  let kx = 0;
  let ky = 0;
  if (keys.has("arrowleft") || keys.has("a")) kx -= 1;
  if (keys.has("arrowright") || keys.has("d")) kx += 1;
  if (keys.has("arrowup") || keys.has("w")) ky -= 1;
  if (keys.has("arrowdown") || keys.has("s")) ky += 1;
  return { kx, ky };
}

// Shared by the host/solo simulation and the ally's local prediction so both
// move a plane toward a target identically.
function stepPlayerPosition(
  pl: { x: number; y: number; targetX: number; targetY: number },
  keys: Set<string>,
  dt: number,
  width: number,
  height: number
) {
  const { kx, ky } = keyboardVector(keys);
  if (kx !== 0 || ky !== 0) {
    const speed = 320;
    const len = Math.hypot(kx, ky) || 1;
    pl.x = clamp(pl.x + (kx / len) * speed * dt, PLAYER_RADIUS, width - PLAYER_RADIUS);
    pl.y = clamp(pl.y + (ky / len) * speed * dt, PLAYER_RADIUS, height - PLAYER_RADIUS);
    pl.targetX = pl.x;
    pl.targetY = pl.y;
  } else {
    pl.targetX = clamp(pl.targetX, PLAYER_RADIUS, width - PLAYER_RADIUS);
    pl.targetY = clamp(pl.targetY, PLAYER_RADIUS, height - PLAYER_RADIUS);
    pl.x += (pl.targetX - pl.x) * Math.min(1, dt * 10);
    pl.y += (pl.targetY - pl.y) * Math.min(1, dt * 10);
  }
}

const NO_KEYS = new Set<string>();

function formatTime(totalSeconds: number) {
  const whole = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(whole / 60);
  const seconds = whole % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function dist2(ax: number, ay: number, bx: number, by: number) {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

// Each puff is its own radial gradient (soft, feathered edge) rather than a
// flat-filled circle, so clouds read as hazy and wispy instead of cartoonish.
function drawCloud(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, opacity: number) {
  const puffs = [
    { dx: -r * 0.9, dy: r * 0.15, pr: r * 0.6 },
    { dx: -r * 0.25, dy: -r * 0.2, pr: r * 0.75 },
    { dx: r * 0.4, dy: -r * 0.1, pr: r * 0.68 },
    { dx: r * 0.95, dy: r * 0.2, pr: r * 0.52 },
    { dx: 0, dy: r * 0.28, pr: r * 0.8 },
  ];
  for (const puff of puffs) {
    const px = x + puff.dx;
    const py = y + puff.dy;
    const grad = ctx.createRadialGradient(px, py, 0, px, py, puff.pr);
    grad.addColorStop(0, `rgba(255,255,255,${opacity})`);
    grad.addColorStop(0.55, `rgba(250,252,255,${opacity * 0.65})`);
    grad.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(px, py, puff.pr, 0, Math.PI * 2);
    ctx.fill();
  }
}

function spawnExplosion(particles: Particle[], x: number, y: number, colorSet: string[], count = 18) {
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 40 + Math.random() * 140;
    particles.push({
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 0.4 + Math.random() * 0.5,
      maxLife: 0.4 + Math.random() * 0.5,
      size: 2 + Math.random() * 3.5,
      color: colorSet[Math.floor(Math.random() * colorSet.length)],
    });
  }
}

// Draws a shaded, detailed fighter-jet silhouette pointing "up" in local space
// before rotation is applied by the caller.
function drawJet(
  ctx: CanvasRenderingContext2D,
  scale: number,
  flameFlicker: number,
  scheme: {
    bodyTop: string;
    bodyBottom: string;
    stroke: string;
    canopyTop: string;
    canopyBottom: string;
    roundelOuter: string;
    roundelInner: string;
    accent: string;
  }
) {
  ctx.save();
  ctx.scale(scale, scale);

  // Engine flame (drawn first so the fuselage overlaps its base)
  const flameLen = 10 + flameFlicker * 6;
  const flameGrad = ctx.createLinearGradient(0, 20, 0, 20 + flameLen);
  flameGrad.addColorStop(0, "rgba(255,230,140,0.95)");
  flameGrad.addColorStop(0.5, "rgba(255,140,40,0.75)");
  flameGrad.addColorStop(1, "rgba(255,90,30,0)");
  ctx.fillStyle = flameGrad;
  ctx.beginPath();
  ctx.moveTo(-3.4, 20);
  ctx.quadraticCurveTo(0, 20 + flameLen, 3.4, 20);
  ctx.closePath();
  ctx.fill();

  // Fuselage + delta wings + tail silhouette
  const grad = ctx.createLinearGradient(0, -24, 0, 24);
  grad.addColorStop(0, scheme.bodyTop);
  grad.addColorStop(1, scheme.bodyBottom);

  ctx.beginPath();
  ctx.moveTo(0, -24);
  ctx.bezierCurveTo(3, -21, 5, -15, 5, -8);
  ctx.lineTo(19, 3);
  ctx.lineTo(20.5, 7.5);
  ctx.lineTo(6, 6.5);
  ctx.lineTo(7, 15.5);
  ctx.lineTo(13.5, 19.5);
  ctx.lineTo(4, 18.5);
  ctx.lineTo(3.2, 23.5);
  ctx.lineTo(-3.2, 23.5);
  ctx.lineTo(-4, 18.5);
  ctx.lineTo(-13.5, 19.5);
  ctx.lineTo(-7, 15.5);
  ctx.lineTo(-6, 6.5);
  ctx.lineTo(-20.5, 7.5);
  ctx.lineTo(-19, 3);
  ctx.lineTo(-5, -8);
  ctx.bezierCurveTo(-5, -15, -3, -21, 0, -24);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.lineWidth = 0.7;
  ctx.strokeStyle = scheme.stroke;
  ctx.stroke();

  // Wing accent stripes
  ctx.fillStyle = scheme.accent;
  ctx.beginPath();
  ctx.moveTo(19, 3);
  ctx.lineTo(20.5, 7.5);
  ctx.lineTo(15, 6.9);
  ctx.lineTo(14.2, 3.6);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(-19, 3);
  ctx.lineTo(-20.5, 7.5);
  ctx.lineTo(-15, 6.9);
  ctx.lineTo(-14.2, 3.6);
  ctx.closePath();
  ctx.fill();

  // Panel lines for a bit of realism
  ctx.strokeStyle = "rgba(0,0,0,0.18)";
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  ctx.moveTo(0, -8);
  ctx.lineTo(0, 18);
  ctx.moveTo(-3, 0);
  ctx.lineTo(-6, 6.5);
  ctx.moveTo(3, 0);
  ctx.lineTo(6, 6.5);
  ctx.stroke();

  // Canopy / cockpit glass
  const canopyGrad = ctx.createLinearGradient(0, -18, 0, -5);
  canopyGrad.addColorStop(0, scheme.canopyTop);
  canopyGrad.addColorStop(1, scheme.canopyBottom);
  ctx.beginPath();
  ctx.ellipse(0, -12, 2.6, 7, 0, 0, Math.PI * 2);
  ctx.fillStyle = canopyGrad;
  ctx.fill();
  ctx.lineWidth = 0.5;
  ctx.strokeStyle = "rgba(0,0,0,0.4)";
  ctx.stroke();
  // canopy glint
  ctx.beginPath();
  ctx.ellipse(-0.9, -14.5, 0.7, 2.4, -0.3, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.fill();

  // Roundel
  ctx.beginPath();
  ctx.arc(0, 1, 3.4, 0, Math.PI * 2);
  ctx.fillStyle = scheme.roundelOuter;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(0, 1, 1.6, 0, Math.PI * 2);
  ctx.fillStyle = scheme.roundelInner;
  ctx.fill();

  ctx.restore();
}

function drawMissile(ctx: CanvasRenderingContext2D, wobble: number) {
  ctx.save();
  // exhaust
  const flameGrad = ctx.createLinearGradient(0, -6, 0, -14);
  flameGrad.addColorStop(0, "rgba(255,200,120,0.9)");
  flameGrad.addColorStop(1, "rgba(255,90,30,0)");
  ctx.fillStyle = flameGrad;
  ctx.beginPath();
  ctx.moveTo(-1.6, -6);
  ctx.quadraticCurveTo(0 + wobble, -13, 1.6, -6);
  ctx.closePath();
  ctx.fill();

  const grad = ctx.createLinearGradient(-2.2, 0, 2.2, 0);
  grad.addColorStop(0, "#8a8f96");
  grad.addColorStop(0.5, "#e7eaee");
  grad.addColorStop(1, "#6b7076");
  ctx.beginPath();
  ctx.moveTo(0, -6);
  ctx.lineTo(2.2, 3);
  ctx.lineTo(2.2, 8);
  ctx.lineTo(3.8, 10);
  ctx.lineTo(1.6, 9);
  ctx.lineTo(1.6, 3.4);
  ctx.lineTo(-1.6, 3.4);
  ctx.lineTo(-1.6, 9);
  ctx.lineTo(-3.8, 10);
  ctx.lineTo(-2.2, 8);
  ctx.lineTo(-2.2, 3);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.35)";
  ctx.lineWidth = 0.4;
  ctx.stroke();

  ctx.fillStyle = "#d43b3b";
  ctx.fillRect(-1.6, 0, 3.2, 1.6);
  ctx.restore();
}

function drawBomb(ctx: CanvasRenderingContext2D) {
  ctx.save();
  const grad = ctx.createLinearGradient(-3, 0, 3, 0);
  grad.addColorStop(0, "#3a3d33");
  grad.addColorStop(0.5, "#6b6f5e");
  grad.addColorStop(1, "#25271f");
  ctx.beginPath();
  ctx.ellipse(0, 0, 3.2, 6.5, 0, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.4)";
  ctx.lineWidth = 0.5;
  ctx.stroke();

  // tail fins
  ctx.fillStyle = "#20221b";
  ctx.beginPath();
  ctx.moveTo(0, 4.5);
  ctx.lineTo(4.5, 8.5);
  ctx.lineTo(1.4, 6.5);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(0, 4.5);
  ctx.lineTo(-4.5, 8.5);
  ctx.lineTo(-1.4, 6.5);
  ctx.closePath();
  ctx.fill();

  // nose highlight
  ctx.beginPath();
  ctx.ellipse(-1, -3.5, 0.9, 1.8, -0.3, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,255,255,0.35)";
  ctx.fill();

  ctx.fillStyle = "#c73a2f";
  ctx.beginPath();
  ctx.arc(0, -1, 0.9, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawCash(ctx: CanvasRenderingContext2D, shine: number) {
  ctx.save();
  const grad = ctx.createLinearGradient(0, -9, 0, 9);
  grad.addColorStop(0, "#fff3b0");
  grad.addColorStop(0.5, "#ffd23f");
  grad.addColorStop(1, "#c98a1f");
  ctx.beginPath();
  ctx.arc(0, 0, 9, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.strokeStyle = "#8a5c14";
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(0, 0, 6.4, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(255,255,255,0.55)";
  ctx.lineWidth = 0.6;
  ctx.stroke();

  ctx.fillStyle = "#8a5c14";
  ctx.font = "bold 11px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("$", 0, 0.5);

  // soft rotating glint so it reads as shiny while falling
  ctx.globalAlpha = 0.5 + shine * 0.3;
  ctx.beginPath();
  ctx.ellipse(-3 + shine * 4, -3, 2.2, 1, -0.5, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,255,255,0.8)";
  ctx.fill();
  ctx.restore();
}

function drawBullet(ctx: CanvasRenderingContext2D) {
  const grad = ctx.createLinearGradient(0, -7, 0, 5);
  grad.addColorStop(0, "rgba(255,255,255,0.95)");
  grad.addColorStop(0.5, "rgba(255,241,150,0.95)");
  grad.addColorStop(1, "rgba(255,190,60,0.15)");
  ctx.beginPath();
  ctx.moveTo(0, -7);
  ctx.quadraticCurveTo(1.6, -2, 1.1, 5);
  ctx.quadraticCurveTo(0, 6, -1.1, 5);
  ctx.quadraticCurveTo(-1.6, -2, 0, -7);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();
}

const PLAYER_SCHEME = {
  bodyTop: "#eef2f6",
  bodyBottom: "#8d99a6",
  stroke: "#2c333a",
  canopyTop: "#bfe6ff",
  canopyBottom: "#0d3a5c",
  roundelOuter: "#1c5fb0",
  roundelInner: "#ffffff",
  accent: "#d1372c",
};

const ALLY_SCHEME_GREEN = {
  bodyTop: "#eafbea",
  bodyBottom: "#5fa876",
  stroke: "#1f3d29",
  canopyTop: "#bfffd8",
  canopyBottom: "#0d3a1f",
  roundelOuter: "#1f8a3d",
  roundelInner: "#ffffff",
  accent: "#f2c744",
};

const ALLY_SCHEME_AMBER = {
  bodyTop: "#fff3df",
  bodyBottom: "#c98a3a",
  stroke: "#4a2e0d",
  canopyTop: "#ffe6b3",
  canopyBottom: "#5c3a0d",
  roundelOuter: "#d98c1f",
  roundelInner: "#ffffff",
  accent: "#2c5fa8",
};

const PLAYER_SCHEMES = [PLAYER_SCHEME, ALLY_SCHEME_GREEN, ALLY_SCHEME_AMBER];

const ENEMY_SCHEME = {
  bodyTop: "#5c5f66",
  bodyBottom: "#26282c",
  stroke: "#111214",
  canopyTop: "#ffb199",
  canopyBottom: "#4a0d0d",
  roundelOuter: "#b7141f",
  roundelInner: "#161616",
  accent: "#e0e0e0",
};

function readStoredBest(): number {
  if (typeof window === "undefined") return 0;
  try {
    return parseInt(window.localStorage.getItem("skyfighter-best") ?? "0", 10) || 0;
  } catch {
    return 0;
  }
}

export default function FighterGame() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef<GameState | null>(null);
  const statusRef = useRef<Status>("ready");
  const rafRef = useRef<number>(0);
  const lastTimeRef = useRef<number>(0);
  const timerValueRef = useRef<HTMLDivElement | null>(null);
  const lobbyModeRef = useRef<LobbyMode>("solo");

  const localIdRef = useRef<string>("");
  const netRoleRef = useRef<NetRole>("solo");
  const playerIdsRef = useRef<string[]>([]);
  const channelRef = useRef<PresenceChannel | null>(null);
  const pendingInputsRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const broadcastAccumRef = useRef(0);
  const inputAccumRef = useRef(0);
  const latestSnapshotRef = useRef<NetSnapshot | null>(null);
  const appliedSnapshotRef = useRef<NetSnapshot | null>(null);
  // The ally's own desired position, tracked separately from GameState.players
  // because that array gets wholesale-replaced by every incoming network
  // snapshot. localPosRef is the ally's client-side-predicted plane position;
  // localTargetRef is what pointer/keyboard input is steering toward.
  const localTargetRef = useRef({ x: 0, y: 0 });
  const localPosRef = useRef<{ x: number; y: number } | null>(null);

  const [status, setStatus] = useState<Status>("ready");
  const [score, setScore] = useState(0);
  // Per-player scores, index-aligned with playerIdsRef.current / s.players
  // (index 0 is always whoever started the game — the host in co-op, the
  // solo player otherwise; index 1, when present, is their ally).
  const [scores, setScores] = useState<number[]>([0]);
  const scoresRef = useRef<number[]>([0]);
  const [lives, setLives] = useState(3);
  const [maxLives, setMaxLives] = useState(3);
  const [cashTotal, setCashTotal] = useState(0);
  const [hostLeft, setHostLeft] = useState(false);

  // Kept in refs so the game-loop closure (created once) can read the
  // latest score/lives/cash when building a host broadcast snapshot.
  const scoreRef = useRef(score);
  const livesRef = useRef(lives);
  const maxLivesRef = useRef(maxLives);
  const cashTotalRef = useRef(cashTotal);
  useEffect(() => {
    scoreRef.current = score;
  }, [score]);
  useEffect(() => {
    livesRef.current = lives;
  }, [lives]);
  useEffect(() => {
    maxLivesRef.current = maxLives;
  }, [maxLives]);
  useEffect(() => {
    cashTotalRef.current = cashTotal;
  }, [cashTotal]);
  // Seeded with an SSR-safe default (matching the server-rendered markup) and
  // synced from localStorage in a mount effect below, to avoid a hydration
  // mismatch for returning players whose real best score differs from this.
  const [best, setBest] = useState(0);

  const [lobbyMode, setLobbyMode] = useState<LobbyMode>("solo");
  const [netRole, setNetRole] = useState<NetRole>("solo");
  const [roomCode, setRoomCode] = useState("");
  const [joinCodeInput, setJoinCodeInput] = useState("");
  const [connStatus, setConnStatus] = useState<ConnStatus>("idle");
  const [connError, setConnError] = useState("");
  const [teammateIds, setTeammateIds] = useState<string[]>([]);

  const [user, setUser] = useState<AuthUser | null>(null);
  const userRef = useRef<AuthUser | null>(null);
  const [refreshLeaderboardKey, setRefreshLeaderboardKey] = useState(0);

  useEffect(() => {
    localIdRef.current = getClientId();
  }, []);

  useEffect(() => {
    // Reads localStorage after hydration (not in the initial state) so the
    // client's first render matches the server's SSR-safe default.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBest(readStoredBest());
  }, []);

  useEffect(() => {
    userRef.current = user;
  }, [user]);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    lobbyModeRef.current = lobbyMode;
  }, [lobbyMode]);

  useEffect(() => {
    netRoleRef.current = netRole;
  }, [netRole]);

  const resetLobby = () => {
    if (channelRef.current && roomCode) {
      leaveRoom(roomCode);
      channelRef.current = null;
    }
    setConnStatus("idle");
    setConnError("");
    setRoomCode("");
    setTeammateIds([]);
  };

  const selectLobbyMode = (mode: LobbyMode) => {
    resetLobby();
    setLobbyMode(mode);
  };

  const beginGame = (role: NetRole, playerIds: string[]) => {
    netRoleRef.current = role;
    setNetRole(role);
    playerIdsRef.current = playerIds;
    setHostLeft(false);
    const el = containerRef.current;
    const width = el?.clientWidth ?? 360;
    const height = el?.clientHeight ?? 640;
    stateRef.current = makeInitialState(width, height, 1, playerIds);
    localPosRef.current = null;
    const spawnedLocal = stateRef.current.players.find((p) => p.id === localIdRef.current);
    if (spawnedLocal) {
      localTargetRef.current = { x: spawnedLocal.x, y: spawnedLocal.y };
    }
    setScore(0);
    scoreRef.current = 0;
    scoresRef.current = playerIds.map(() => 0);
    setScores(scoresRef.current);
    const total = 3 + (playerIds.length - 1);
    setMaxLives(total);
    maxLivesRef.current = total;
    setLives(total);
    livesRef.current = total;
    setCashTotal(0);
    cashTotalRef.current = 0;
    // Set synchronously (not just via the status-syncing effect) so the
    // game-loop closure never reads a stale ref for the one tick between
    // this call and the next React commit.
    statusRef.current = "playing";
    setStatus("playing");
  };

  const startSolo = () => {
    beginGame("solo", [localIdRef.current]);
  };

  const hostRoom = () => {
    const code = generateRoomCode();
    setRoomCode(code);
    setConnStatus("connecting");
    setConnError("");
    const channel = subscribeToRoom(code);
    channelRef.current = channel;

    channel.bind("pusher:subscription_succeeded", () => {
      setConnStatus("connected");
    });
    channel.bind("pusher:subscription_error", () => {
      setConnStatus("error");
      setConnError("Could not create the room. Please try again.");
    });
    const syncTeammates = () => {
      const ids: string[] = [];
      channel.members.each((member: { id: string }) => {
        if (member.id !== localIdRef.current) ids.push(member.id);
      });
      setTeammateIds(ids);
    };
    channel.bind("pusher:member_added", syncTeammates);
    channel.bind("pusher:member_removed", syncTeammates);
    channel.bind("client-input", (data: InputMessage) => {
      pendingInputsRef.current.set(data.id, { x: data.x, y: data.y });
    });
  };

  const hostStartOrRestart = () => {
    const ids = [localIdRef.current, ...teammateIds].slice(0, MAX_PLAYERS);
    channelRef.current?.trigger("client-start", { level: 1, playerIds: ids } satisfies StartMessage);
    beginGame("host", ids);
  };

  const joinRoom = (code: string) => {
    if (!/^\d{3}$/.test(code)) {
      setConnStatus("error");
      setConnError("Enter the 3-digit code your host shared.");
      return;
    }
    setRoomCode(code);
    setConnStatus("connecting");
    setConnError("");
    const channel = subscribeToRoom(code);
    channelRef.current = channel;

    channel.bind("pusher:subscription_succeeded", () => {
      setConnStatus("connected");
    });
    channel.bind("pusher:subscription_error", () => {
      setConnStatus("error");
      setConnError("Couldn't join — check the code and try again.");
    });
    channel.bind("client-start", (data: StartMessage) => {
      beginGame("ally", data.playerIds);
    });
    channel.bind("client-state", (data: NetSnapshot) => {
      latestSnapshotRef.current = data;
    });
    channel.bind("pusher:member_removed", (member: { id: string }) => {
      if (netRoleRef.current === "ally" && member.id === playerIdsRef.current[0]) {
        setHostLeft(true);
        statusRef.current = "gameover";
        setStatus("gameover");
      }
    });
  };

  const handleStart = () => {
    if (lobbyMode === "solo") startSolo();
    else if (lobbyMode === "host") hostStartOrRestart();
  };

  const handlePlayAgain = () => {
    if (netRole === "host") hostStartOrRestart();
    else startSolo();
  };

  const backToMenu = () => {
    resetLobby();
    setLobbyMode("solo");
    setNetRole("solo");
    netRoleRef.current = "solo";
    setStatus("ready");
  };

  const handleQuit = () => {
    resetLobby();
    statusRef.current = "quit";
    setStatus("quit");
  };

  const handleUserChange = (u: AuthUser | null) => {
    setUser(u);
    if (u) {
      setBest((b) => Math.max(b, u.highScore));
    }
  };

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = container.clientWidth;
      const height = container.clientHeight;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (stateRef.current) {
        const s = stateRef.current;
        const scaleX = width / s.width;
        const scaleY = height / s.height;
        s.width = width;
        s.height = height;
        for (const pl of s.players) {
          pl.x = clamp(pl.x * scaleX, PLAYER_RADIUS, width - PLAYER_RADIUS);
          pl.y = clamp(pl.y * scaleY, PLAYER_RADIUS, height - PLAYER_RADIUS);
          pl.targetX = pl.x;
          pl.targetY = pl.y;
        }
      } else {
        stateRef.current = makeInitialState(width, height, 1, [localIdRef.current || "local"]);
      }
    };
    resize();

    const ro = new ResizeObserver(resize);
    ro.observe(container);

    const getLocalPoint = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect();
      return { x: clientX - rect.left, y: clientY - rect.top };
    };

    const getLocalPlayer = (s: GameState) =>
      s.players.find((pl) => pl.id === localIdRef.current) ?? s.players[0];

    const onPointerDown = (e: PointerEvent) => {
      const s = stateRef.current;
      if (!s) return;
      s.pointerDown = true;
      const p = getLocalPoint(e.clientX, e.clientY);
      localTargetRef.current = p;
      const pl = getLocalPlayer(s);
      if (pl) {
        pl.targetX = p.x;
        pl.targetY = p.y;
      }
      if (statusRef.current === "ready" && lobbyModeRef.current === "solo") {
        startSolo();
      }
      e.preventDefault();
    };
    const onPointerMove = (e: PointerEvent) => {
      const s = stateRef.current;
      if (!s) return;
      if (e.pointerType === "mouse" || s.pointerDown) {
        const p = getLocalPoint(e.clientX, e.clientY);
        localTargetRef.current = p;
        const pl = getLocalPlayer(s);
        if (pl) {
          pl.targetX = p.x;
          pl.targetY = p.y;
        }
      }
    };
    const onPointerUp = () => {
      const s = stateRef.current;
      if (s) s.pointerDown = false;
    };

    canvas.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    canvas.style.touchAction = "none";

    const onKeyDown = (e: KeyboardEvent) => {
      const keys = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "w", "a", "s", "d", "W", "A", "S", "D"];
      if (keys.includes(e.key)) {
        e.preventDefault();
        stateRef.current?.keys.add(e.key.toLowerCase());
        if (statusRef.current === "ready" && lobbyModeRef.current === "solo") {
          startSolo();
        }
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      stateRef.current?.keys.delete(e.key.toLowerCase());
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    const onVisibility = () => {
      if (!document.hidden) lastTimeRef.current = performance.now();
    };
    document.addEventListener("visibilitychange", onVisibility);

    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - lastTimeRef.current) / 1000 || 0);
      lastTimeRef.current = now;
      const s = stateRef.current;
      if (s) {
        if (netRoleRef.current === "ally") {
          if (statusRef.current === "playing") {
            // Snapshots arrive at ~8/sec; only re-sync from a snapshot the
            // moment it's new, so the per-frame extrapolation below has a
            // chance to actually accumulate motion between arrivals instead
            // of being reset back to the same stale values every frame.
            if (latestSnapshotRef.current && latestSnapshotRef.current !== appliedSnapshotRef.current) {
              applySnapshot(s, latestSnapshotRef.current);
              appliedSnapshotRef.current = latestSnapshotRef.current;
            }
            extrapolateAlly(s, dt);

            // Client-side prediction: move our own plane locally & instantly
            // instead of waiting a full network round trip (input -> host ->
            // broadcast -> us) before we see it respond. applySnapshot just
            // overwrote every player from the host's data, so immediately
            // override our own entry with the locally-predicted position.
            const localPl = s.players.find((p) => p.id === localIdRef.current);
            if (localPl) {
              if (!localPosRef.current) {
                localPosRef.current = { x: localPl.x, y: localPl.y };
              }
              const stepObj = {
                x: localPosRef.current.x,
                y: localPosRef.current.y,
                targetX: localTargetRef.current.x,
                targetY: localTargetRef.current.y,
              };
              stepPlayerPosition(stepObj, s.keys, dt, s.width, s.height);
              localPosRef.current.x = stepObj.x;
              localPosRef.current.y = stepObj.y;
              localTargetRef.current.x = stepObj.targetX;
              localTargetRef.current.y = stepObj.targetY;
              localPl.x = stepObj.x;
              localPl.y = stepObj.y;
            }

            inputAccumRef.current += dt;
            if (inputAccumRef.current >= INPUT_SEND_INTERVAL) {
              inputAccumRef.current = 0;
              if (channelRef.current) {
                channelRef.current.trigger("client-input", {
                  id: localIdRef.current,
                  x: localTargetRef.current.x,
                  y: localTargetRef.current.y,
                } satisfies InputMessage);
              }
            }
          }
        } else {
          if (statusRef.current === "playing") {
            if (netRoleRef.current === "host") {
              for (const [id, target] of pendingInputsRef.current) {
                const pl = s.players.find((p) => p.id === id);
                if (pl) {
                  pl.targetX = target.x;
                  pl.targetY = target.y;
                }
              }
            }
            update(s, dt);
          }
          // Keep broadcasting after the round ends too, so a host transitioning
          // straight from "playing" to "levelcomplete"/"gameover" in the same
          // tick still reliably delivers that final status to allies.
          if (netRoleRef.current === "host" && channelRef.current && statusRef.current !== "ready") {
            broadcastAccumRef.current += dt;
            if (broadcastAccumRef.current >= BROADCAST_INTERVAL) {
              broadcastAccumRef.current = 0;
              channelRef.current.trigger("client-state", buildSnapshot(s, statusRef.current));
            }
          }
        }
        render(ctx, s, statusRef.current);
      }
      rafRef.current = requestAnimationFrame(loop);
    };

    // Runs every frame on the ally's client (not just when a fresh snapshot
    // arrives) to dead-reckon fast-moving entities forward using their
    // last-known velocity. Snapshots only arrive ~8/sec (Pusher's client-event
    // cap), so without this everything but the ally's own plane would freeze
    // between updates and visibly teleport — this is what read as "lag".
    function extrapolateAlly(s: GameState, dt: number) {
      for (const pl of s.players) {
        if (pl.id === localIdRef.current) continue;
        pl.x += (pl.targetX - pl.x) * Math.min(1, dt * 10);
        pl.y += (pl.targetY - pl.y) * Math.min(1, dt * 10);
      }
      for (const en of s.enemies) {
        en.y += en.vy * dt;
      }
      for (const m of s.missiles) {
        m.x += m.vx * dt;
        m.y += m.vy * dt;
      }
      for (const bm of s.bombs) {
        bm.vy += GRAVITY * dt;
        bm.y += bm.vy * dt;
      }
      for (const b of s.bullets) {
        b.y += b.vy * dt;
      }
      for (const csh of s.cash) {
        csh.y += csh.vy * dt;
      }
    }

    function applySnapshot(s: GameState, snap: NetSnapshot | null) {
      if (!snap) return;
      const scaleX = s.width / snap.width;
      const scaleY = s.height / snap.height;
      s.level = snap.level;
      s.levelDuration = snap.levelDuration;
      s.elapsed = snap.elapsed;
      s.players = snap.players.map((np) => {
        const targetX = np.x * scaleX;
        const targetY = np.y * scaleY;
        const existing = np.id === localIdRef.current ? undefined : s.players.find((p) => p.id === np.id);
        return {
          id: np.id,
          x: existing ? existing.x : targetX,
          y: existing ? existing.y : targetY,
          targetX,
          targetY,
          invuln: np.invuln,
          fireTimer: 0,
        };
      });
      s.enemies = snap.enemies.map((ne) => ({
        x: ne.x * scaleX,
        y: ne.y * scaleY,
        vy: ne.vy,
        phase: ne.phase,
        amp: 0,
        scale: ne.scale,
        fireTimer: 1,
        bombTimer: 1,
      }));
      s.missiles = snap.missiles.map((nm) => ({
        x: nm.x * scaleX,
        y: nm.y * scaleY,
        vx: nm.vx,
        vy: nm.vy,
      }));
      s.bombs = snap.bombs.map((nb) => ({ x: nb.x * scaleX, y: nb.y * scaleY, vy: nb.vy, rot: nb.rot }));
      s.bullets = snap.bullets.map((nb) => ({ x: nb.x * scaleX, y: nb.y * scaleY, vy: nb.vy, ownerId: "" }));
      s.cash = snap.cash.map((nc) => ({ x: nc.x * scaleX, y: nc.y * scaleY, vy: nc.vy, phase: 0 }));

      const newScores = snap.players.map((np) => np.score);
      scoresRef.current = newScores;
      setScores((prev) =>
        prev.length === newScores.length && prev.every((v, i) => v === newScores[i]) ? prev : newScores
      );
      setScore((prev) => (prev !== snap.score ? snap.score : prev));
      setLives((prev) => (prev !== snap.lives ? snap.lives : prev));
      setCashTotal((prev) => (prev !== snap.cashTotal ? snap.cashTotal : prev));
      if (snap.status !== statusRef.current) {
        statusRef.current = snap.status;
        setStatus(snap.status);
      }
    }

    function buildSnapshot(s: GameState, currentStatus: Status): NetSnapshot {
      return {
        status: currentStatus === "ready" ? "playing" : currentStatus === "quit" ? "gameover" : currentStatus,
        width: round1(s.width),
        height: round1(s.height),
        level: s.level,
        levelDuration: round1(s.levelDuration),
        elapsed: round1(s.elapsed),
        score: scoreRef.current,
        lives: livesRef.current,
        cashTotal: cashTotalRef.current,
        players: s.players.map((pl, i) => ({
          id: pl.id,
          x: round1(pl.x),
          y: round1(pl.y),
          invuln: round1(pl.invuln),
          score: scoresRef.current[i] ?? 0,
        })),
        enemies: s.enemies
          .slice(0, MAX_SNAPSHOT_ENTITIES)
          .map((en) => ({
            x: round1(en.x),
            y: round1(en.y),
            vy: round1(en.vy),
            scale: round1(en.scale),
            phase: round1(en.phase),
          })),
        missiles: s.missiles
          .slice(0, MAX_SNAPSHOT_ENTITIES)
          .map((m) => ({ x: round1(m.x), y: round1(m.y), vx: round1(m.vx), vy: round1(m.vy) })),
        bombs: s.bombs
          .slice(0, MAX_SNAPSHOT_ENTITIES)
          .map((b) => ({ x: round1(b.x), y: round1(b.y), vy: round1(b.vy), rot: round1(b.rot) })),
        bullets: s.bullets
          .slice(0, MAX_SNAPSHOT_ENTITIES)
          .map((b) => ({ x: round1(b.x), y: round1(b.y), vy: round1(b.vy) })),
        cash: s.cash
          .slice(0, MAX_SNAPSHOT_ENTITIES)
          .map((csh) => ({ x: round1(csh.x), y: round1(csh.y), vy: round1(csh.vy) })),
      };
    }

    function update(s: GameState, dt: number) {
      s.elapsed += dt;

      // Keyboard input only ever drives this device's own player entity;
      // everyone else (host/solo's own plane, or a relayed ally) just lerps
      // toward whatever target position was last set for them.
      for (const pl of s.players) {
        const keys = pl.id === localIdRef.current ? s.keys : NO_KEYS;
        stepPlayerPosition(pl, keys, dt, s.width, s.height);
        if (pl.invuln > 0) pl.invuln -= dt;
      }

      // clouds
      for (const c of s.clouds) {
        c.y += c.speed * dt;
        if (c.y - c.r > s.height) {
          c.y = -c.r;
          c.x = Math.random() * s.width;
        }
      }

      // auto-fire, one volley per player
      for (const pl of s.players) {
        pl.fireTimer -= dt;
        if (pl.fireTimer <= 0) {
          pl.fireTimer = 0.18;
          s.bullets.push({ x: pl.x - 7, y: pl.y - 14, vy: -560, ownerId: pl.id });
          s.bullets.push({ x: pl.x + 7, y: pl.y - 14, vy: -560, ownerId: pl.id });
        }
      }
      for (const b of s.bullets) b.y += b.vy * dt;
      s.bullets = s.bullets.filter((b) => b.y > -20);

      // Difficulty is driven by the level being played, stepped up +4% for
      // every full minute survived, and oscillates between a bomb-heavy
      // phase and a swarm-heavy phase as it climbs.
      const difficulty = levelDifficulty(s.level) * timeDifficultyMultiplier(s.elapsed);
      const { bombFocus, swarmFocus } = phaseFocus(s.elapsed);
      s.spawnTimer -= dt;
      if (s.spawnTimer <= 0) {
        s.spawnTimer = clamp(1.6 - difficulty * 0.5 - swarmFocus * 0.3, 0.45, 1.6) + Math.random() * 0.3;
        // One extra enemy per teammate so co-op stays a real challenge, plus
        // a little more on top during the peak of a squadron-swarm phase.
        const extraSwarm = Math.min(1, Math.floor(swarmFocus * 2.2));
        for (let i = 0; i < s.players.length + extraSwarm; i++) {
          s.enemies.push({
            x: 30 + Math.random() * (s.width - 60),
            y: -30 - i * 40,
            vy: 55 + Math.random() * 35 + Math.min(difficulty, 8) * 40,
            phase: Math.random() * Math.PI * 2,
            amp: 20 + Math.random() * 40,
            scale: 0.85 + Math.random() * 0.35,
            fireTimer: 1.8 + Math.random() * 1.8,
            bombTimer: 1.2 + Math.random() * 2.2,
          });
        }
      }

      for (const en of s.enemies) {
        en.y += en.vy * dt;
        en.phase += dt * 1.6;
        en.x = clamp(en.x + Math.sin(en.phase) * en.amp * dt * 0.6, 20, s.width - 20);
        en.fireTimer -= dt;
        if (en.fireTimer <= 0 && en.y > 10 && en.y < s.height - 60 && s.players.length > 0) {
          en.fireTimer = clamp(2.2 - difficulty * 0.3, 0.6, 2.2) + Math.random() * 1.6;
          let nearest = s.players[0];
          let nearestD = dist2(en.x, en.y, nearest.x, nearest.y);
          for (const pl of s.players) {
            const d = dist2(en.x, en.y, pl.x, pl.y);
            if (d < nearestD) {
              nearest = pl;
              nearestD = d;
            }
          }
          const dx = nearest.x - en.x;
          const dy = nearest.y - en.y;
          const len = Math.hypot(dx, dy) || 1;
          s.missiles.push({
            x: en.x,
            y: en.y + 10,
            vy: (dy / len) * 190 + 80,
            vx: (dx / len) * 100,
          });
        }
        en.bombTimer -= dt;
        if (en.bombTimer <= 0 && en.y > 10 && en.y < s.height - 100) {
          en.bombTimer = clamp(2.8 - difficulty * 0.35 - bombFocus * 1.8, 0.35, 2.8) + Math.random() * 2.4;
          s.bombs.push({ x: en.x, y: en.y + 12, vy: 40, rot: Math.random() * Math.PI * 2 });
        }
      }
      s.enemies = s.enemies.filter((en) => en.y < s.height + 40);

      // Cash drops on its own timer, independent of the enemy/bomb difficulty
      // ramp — it's a recovery mechanic, not a hazard, so it never gets
      // scarcer as the run gets harder. It does get more frequent the longer
      // the run goes, so recovery keeps pace with the growing pressure.
      s.cashTimer -= dt;
      if (s.cashTimer <= 0) {
        s.cashTimer = (2 + Math.random() * 2.5) / cashRateMultiplier(s.elapsed);
        s.cash.push({
          x: 24 + Math.random() * (s.width - 48),
          y: -20,
          vy: 55 + Math.random() * 20,
          phase: Math.random() * Math.PI * 2,
        });
      }
      for (const csh of s.cash) {
        csh.y += csh.vy * dt;
        csh.phase += dt * 2.2;
        csh.x = clamp(csh.x + Math.sin(csh.phase) * 16 * dt, 12, s.width - 12);
      }
      s.cash = s.cash.filter((csh) => csh.y < s.height + 30);

      for (const m of s.missiles) {
        let nearest = s.players[0];
        if (nearest) {
          let nearestD = dist2(m.x, m.y, nearest.x, nearest.y);
          for (const pl of s.players) {
            const d = dist2(m.x, m.y, pl.x, pl.y);
            if (d < nearestD) {
              nearest = pl;
              nearestD = d;
            }
          }
          const dx = nearest.x - m.x;
          // gentle homing so missiles are threatening but still dodgeable
          m.vx += clamp(dx, -1, 1) * 16 * dt;
        }
        m.x += m.vx * dt;
        m.y += m.vy * dt;
      }
      s.missiles = s.missiles.filter((m) => m.y < s.height + 30);

      // bombs fall straight down and accelerate under gravity, unlike homing missiles
      for (const bm of s.bombs) {
        bm.vy += GRAVITY * dt;
        bm.y += bm.vy * dt;
        bm.rot += dt * 2.4;
      }
      s.bombs = s.bombs.filter((bm) => bm.y < s.height + 30);

      // bullet vs enemy — credited to whichever plane fired the killing shot,
      // so co-op tracks each pilot's own score alongside the team total.
      const deadEnemies = new Set<Enemy>();
      const deadBullets = new Set<Bullet>();
      let scored = false;
      for (const b of s.bullets) {
        for (const en of s.enemies) {
          if (deadEnemies.has(en) || deadBullets.has(b)) continue;
          const r = ENEMY_RADIUS * en.scale;
          if (dist2(b.x, b.y, en.x, en.y) < r * r) {
            deadEnemies.add(en);
            deadBullets.add(b);
            spawnExplosion(s.particles, en.x, en.y, ["#ffcf5c", "#ff7a3c", "#8a8f96"]);
            const idx = s.players.findIndex((p) => p.id === b.ownerId);
            if (idx >= 0) {
              scoresRef.current[idx] = (scoresRef.current[idx] ?? 0) + 10;
              scored = true;
            }
          }
        }
      }
      if (deadEnemies.size) s.enemies = s.enemies.filter((en) => !deadEnemies.has(en));
      if (deadBullets.size) s.bullets = s.bullets.filter((b) => !deadBullets.has(b));
      if (scored) {
        setScores([...scoresRef.current]);
        scoreRef.current = scoresRef.current.reduce((sum, v) => sum + (v ?? 0), 0);
        setScore(scoreRef.current);
      }

      // cash pickups — any plane flying through one collects it into the
      // shared team total; every full CASH_PER_LIFE collected restores one
      // life back into the shared pool (never past maxLives).
      const collectedCash = new Set<Cash>();
      for (const csh of s.cash) {
        for (const pl of s.players) {
          const r = PLAYER_HIT_RADIUS + CASH_HIT_RADIUS;
          if (dist2(pl.x, pl.y, csh.x, csh.y) < r * r) {
            collectedCash.add(csh);
            break;
          }
        }
      }
      if (collectedCash.size) {
        s.cash = s.cash.filter((csh) => !collectedCash.has(csh));
        for (const csh of collectedCash) {
          spawnExplosion(s.particles, csh.x, csh.y, ["#ffd75e", "#fff3c0", "#c98a1f"], 10);
        }
        const prevTotal = cashTotalRef.current;
        const newTotal = prevTotal + collectedCash.size * CASH_VALUE;
        cashTotalRef.current = newTotal;
        setCashTotal(newTotal);
        const livesToRestore = Math.floor(newTotal / CASH_PER_LIFE) - Math.floor(prevTotal / CASH_PER_LIFE);
        if (livesToRestore > 0) {
          setLives((lv) => Math.min(maxLivesRef.current, lv + livesToRestore));
          const healInvuln = healInvulnDuration(newTotal);
          for (const pl of s.players) {
            pl.invuln = Math.max(pl.invuln, healInvuln);
          }
        }
      }

      // player collisions — shared lives pool across the whole team
      for (const pl of s.players) {
        if (pl.invuln > 0) continue;
        let hitBy: "missile" | "bomb" | "enemy" | null = null;
        for (const m of s.missiles) {
          if (
            dist2(pl.x, pl.y, m.x, m.y) <
            (PLAYER_HIT_RADIUS + MISSILE_HIT_RADIUS) * (PLAYER_HIT_RADIUS + MISSILE_HIT_RADIUS)
          ) {
            hitBy = "missile";
            s.missiles = s.missiles.filter((mm) => mm !== m);
            break;
          }
        }
        if (!hitBy) {
          for (const bm of s.bombs) {
            if (
              dist2(pl.x, pl.y, bm.x, bm.y) <
              (PLAYER_HIT_RADIUS + BOMB_HIT_RADIUS) * (PLAYER_HIT_RADIUS + BOMB_HIT_RADIUS)
            ) {
              hitBy = "bomb";
              s.bombs = s.bombs.filter((bb) => bb !== bm);
              break;
            }
          }
        }
        if (!hitBy) {
          for (const en of s.enemies) {
            const r = PLAYER_HIT_RADIUS + ENEMY_HIT_RADIUS * en.scale;
            if (dist2(pl.x, pl.y, en.x, en.y) < r * r) {
              hitBy = "enemy";
              s.enemies = s.enemies.filter((ee) => ee !== en);
              break;
            }
          }
        }
        if (hitBy) {
          pl.invuln = INVULN_TIME;
          spawnExplosion(s.particles, pl.x, pl.y, ["#8fd3ff", "#ffffff", "#ff7a3c"], 24);
          setLives((lv) => {
            const next = lv - 1;
            if (next <= 0) {
              statusRef.current = "gameover";
              setStatus("gameover");
              setBest((b) => {
                const nb = Math.max(b, scoreRef.current);
                try {
                  window.localStorage.setItem("skyfighter-best", String(nb));
                } catch {
                  // ignore
                }
                if (userRef.current) {
                  fetch("/api/score", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ score: nb, level: 1 }),
                  }).catch(() => {});
                  setRefreshLeaderboardKey((k) => k + 1);
                }
                return nb;
              });
            }
            return next;
          });
        }
      }

      // particles
      for (const pt of s.particles) {
        pt.x += pt.vx * dt;
        pt.y += pt.vy * dt;
        pt.vx *= 0.94;
        pt.vy *= 0.94;
        pt.life -= dt;
      }
      s.particles = s.particles.filter((pt) => pt.life > 0);

      if (statusRef.current === "playing" && s.elapsed >= s.levelDuration) {
        statusRef.current = "levelcomplete";
        setStatus("levelcomplete");
        setBest((b) => {
          const nb = Math.max(b, scoreRef.current);
          try {
            window.localStorage.setItem("skyfighter-best", String(nb));
          } catch {
            // ignore
          }
          if (userRef.current) {
            fetch("/api/score", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ score: nb, level: 1 }),
            }).catch(() => {});
            setRefreshLeaderboardKey((k) => k + 1);
          }
          return nb;
        });
      }
    }

    function render(c: CanvasRenderingContext2D, s: GameState, currentStatus: Status) {
      if (timerValueRef.current) {
        timerValueRef.current.textContent = formatTime(Math.max(0, s.levelDuration - s.elapsed));
      }
      const { width, height } = s;
      const sky = c.createLinearGradient(0, 0, 0, height);
      sky.addColorStop(0, "#155a9e");
      sky.addColorStop(0.4, "#357fbe");
      sky.addColorStop(0.75, "#79aed7");
      sky.addColorStop(1, "#c3dfec");
      c.fillStyle = sky;
      c.fillRect(0, 0, width, height);

      c.save();
      for (const cl of s.clouds) {
        drawCloud(c, cl.x, cl.y, cl.r, cl.opacity);
      }
      c.restore();

      // missiles
      for (const m of s.missiles) {
        c.save();
        c.translate(m.x, m.y);
        const angle = Math.atan2(m.vy, m.vx) - Math.PI / 2;
        c.rotate(angle);
        drawMissile(c, Math.sin(s.elapsed * 30) * 0.8);
        c.restore();
      }

      // bombs
      for (const bm of s.bombs) {
        c.save();
        c.translate(bm.x, bm.y);
        c.rotate(bm.rot);
        drawBomb(c);
        c.restore();
      }

      // cash pickups
      for (const csh of s.cash) {
        c.save();
        c.translate(csh.x, csh.y);
        drawCash(c, Math.sin(csh.phase));
        c.restore();
      }

      // bullets
      for (const b of s.bullets) {
        c.save();
        c.translate(b.x, b.y);
        drawBullet(c);
        c.restore();
      }

      // enemies
      for (const en of s.enemies) {
        c.save();
        c.translate(en.x, en.y);
        c.rotate(Math.PI);
        drawJet(c, en.scale, Math.abs(Math.sin(s.elapsed * 18 + en.phase)), ENEMY_SCHEME);
        c.restore();
      }

      // players
      if (currentStatus !== "gameover") {
        s.players.forEach((pl, i) => {
          const flashHidden = pl.invuln > 0 && Math.floor(pl.invuln * 10) % 2 === 0;
          if (flashHidden) return;
          c.save();
          c.translate(pl.x, pl.y);
          drawJet(c, 1, Math.abs(Math.sin(s.elapsed * 22)), PLAYER_SCHEMES[i % PLAYER_SCHEMES.length]);
          c.restore();
        });
      }

      // particles
      for (const pt of s.particles) {
        const t = pt.life / pt.maxLife;
        c.save();
        c.globalAlpha = clamp(t, 0, 1);
        c.beginPath();
        c.arc(pt.x, pt.y, pt.size * t, 0, Math.PI * 2);
        c.fillStyle = pt.color;
        c.fill();
        c.restore();
      }
    }

    lastTimeRef.current = performance.now();
    rafRef.current = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(rafRef.current);
      ro.disconnect();
      canvas.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return () => {
      if (roomCode) leaveRoom(roomCode);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isAlly = netRole === "ally";

  return (
    <div
      ref={containerRef}
      className="relative h-dvh w-full overflow-hidden select-none bg-[#357fbe]"
    >
      <canvas ref={canvasRef} className="absolute inset-0 block" />

      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between p-3 sm:p-4 text-white font-sans">
        {netRole === "solo" ? (
          <div className="rounded-lg bg-black/35 px-3 py-1.5 backdrop-blur-sm">
            <div className="text-xs uppercase tracking-wide text-white/60">Score</div>
            <div className="text-lg font-bold tabular-nums leading-tight">{score}</div>
          </div>
        ) : (
          <div className="flex gap-1.5">
            <div className="rounded-lg bg-black/35 px-3 py-1.5 backdrop-blur-sm">
              <div className="text-xs uppercase tracking-wide text-white/60">Host</div>
              <div className="text-lg font-bold tabular-nums leading-tight">{scores[0] ?? 0}</div>
            </div>
            <div className="rounded-lg bg-black/35 px-3 py-1.5 backdrop-blur-sm">
              <div className="text-xs uppercase tracking-wide text-white/60">Ally</div>
              <div className="text-lg font-bold tabular-nums leading-tight">{scores[1] ?? 0}</div>
            </div>
          </div>
        )}
        <div className="rounded-lg bg-black/35 px-3 py-1.5 backdrop-blur-sm text-center">
          <div className="text-xs uppercase tracking-wide text-white/60">Time</div>
          <div ref={timerValueRef} className="text-lg font-bold tabular-nums leading-tight">
            0:00
          </div>
        </div>
        <div className="rounded-lg bg-black/35 px-3 py-1.5 backdrop-blur-sm text-center">
          <div className="text-xs uppercase tracking-wide text-white/60">Cash</div>
          <div className="text-lg font-bold tabular-nums leading-tight text-amber-300">${cashTotal}</div>
        </div>
        <div className="flex gap-1.5 rounded-lg bg-black/35 px-3 py-1.5 backdrop-blur-sm">
          {Array.from({ length: maxLives }, (_, i) => (
            <span
              key={i}
              className={`text-lg leading-none ${i < lives ? "opacity-100" : "opacity-25"}`}
            >
              &#9992;
            </span>
          ))}
        </div>
      </div>

      {status === "ready" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 overflow-y-auto bg-black/55 px-6 py-8 text-center text-white font-sans">
          <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight">Sky Fighter</h1>
          <p className="max-w-xs text-sm sm:text-base text-white/80">
            Drag or move your mouse to steer. Your jet auto-fires — dodge homing missiles and falling bombs, and
            shoot down every plane you can.
          </p>

          <div className="flex gap-2 rounded-full bg-white/10 p-1 text-sm">
            {(["solo", "host", "join"] as LobbyMode[]).map((m) => (
              <button
                key={m}
                onClick={() => selectLobbyMode(m)}
                className={`rounded-full px-4 py-1.5 font-semibold transition-colors ${
                  lobbyMode === m ? "bg-red-600" : "text-white/70"
                }`}
              >
                {m === "solo" ? "Single Player" : m === "host" ? "Get Ally" : "Join Ally"}
              </button>
            ))}
          </div>

          {lobbyMode === "host" && (
            <div className="flex flex-col items-center gap-1.5 rounded-xl bg-white/10 px-4 py-3">
              {connStatus === "idle" && (
                <button
                  onClick={hostRoom}
                  className="rounded-full bg-white/20 px-5 py-2 text-sm font-semibold"
                >
                  Invite Ally
                </button>
              )}
              {connStatus === "connecting" && <p className="text-sm">Setting Up…</p>}
              {connStatus === "connected" && (
                <>
                  <p className="text-xs text-white/60">Share this code with your ally</p>
                  <p className="text-3xl font-extrabold tracking-widest tabular-nums">{roomCode}</p>
                  <p
                    className={`flex items-center gap-2 text-base font-extrabold ${
                      teammateIds.length === 0 ? "text-amber-300" : "text-green-300"
                    }`}
                  >
                    <span
                      className={`h-2.5 w-2.5 rounded-full ${
                        teammateIds.length === 0 ? "bg-amber-300 animate-pulse" : "bg-green-300"
                      }`}
                    />
                    {teammateIds.length === 0 ? "Waiting for ally to join…" : "Ally connected!"}
                  </p>
                </>
              )}
              {connStatus === "error" && <p className="text-sm text-red-200">{connError}</p>}
            </div>
          )}

          {lobbyMode === "join" && (
            <div className="flex flex-col items-center gap-2 rounded-xl bg-white/10 px-4 py-3">
              <p className="text-xs text-white/60">Enter your host&apos;s 3-digit room code</p>
              <input
                value={joinCodeInput}
                onChange={(e) => setJoinCodeInput(e.target.value.replace(/\D/g, "").slice(0, 3))}
                inputMode="numeric"
                placeholder="000"
                className="w-40 rounded-lg bg-white/90 px-3 py-2 text-center text-xl font-bold tracking-widest text-black tabular-nums"
              />
              {connStatus !== "connected" && (
                <button
                  onClick={() => joinRoom(joinCodeInput)}
                  className="rounded-full bg-white/20 px-5 py-2 text-sm font-semibold"
                >
                  Join
                </button>
              )}
              {connStatus === "connecting" && <p className="text-sm">Connecting…</p>}
              {connStatus === "connected" && (
                <p className="flex items-center gap-2 text-base font-extrabold text-green-300">
                  <span className="h-2.5 w-2.5 rounded-full bg-green-300 animate-pulse" />
                  Connected! Waiting for host to start…
                </p>
              )}
              {connStatus === "error" && <p className="text-sm text-red-200">{connError}</p>}
            </div>
          )}

          {best > 0 && <p className="text-xs text-white/60">Best score: {best}</p>}

          <AuthPanel onUserChange={handleUserChange} refreshLeaderboardKey={refreshLeaderboardKey} />

          {(lobbyMode === "solo" || (lobbyMode === "host" && connStatus === "connected")) && (
            <button
              onClick={handleStart}
              className="mt-1 rounded-full bg-red-600 px-8 py-3 text-base font-bold shadow-lg shadow-red-900/40 active:scale-95 transition-transform"
            >
              Start
            </button>
          )}
          {lobbyMode === "solo" && <p className="text-xs text-white/50">Arrow keys / WASD also work on desktop</p>}
        </div>
      )}

      {status === "levelcomplete" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black/65 px-6 text-center text-white font-sans">
          <h2 className="text-3xl font-extrabold">Time&apos;s Up!</h2>
          <p className="text-lg">
            Score: <span className="font-bold">{score}</span>
          </p>
          {netRole !== "solo" && (
            <p className="text-sm text-white/70">
              Host: <span className="font-semibold text-white">{scores[0] ?? 0}</span> · Ally:{" "}
              <span className="font-semibold text-white">{scores[1] ?? 0}</span>
            </p>
          )}
          {isAlly ? (
            <p className="text-sm text-white/70">Waiting for host to play again…</p>
          ) : (
            <button
              onClick={handlePlayAgain}
              className="mt-1 rounded-full bg-red-600 px-8 py-3 text-base font-bold shadow-lg shadow-red-900/40 active:scale-95 transition-transform"
            >
              Play Again
            </button>
          )}
          <div className="flex gap-4">
            <button onClick={backToMenu} className="text-sm text-white/70 underline underline-offset-2">
              Main Menu
            </button>
            <button onClick={handleQuit} className="text-sm text-white/70 underline underline-offset-2">
              Quit Game
            </button>
          </div>
        </div>
      )}

      {status === "gameover" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black/65 px-6 text-center text-white font-sans">
          <h2 className="text-3xl font-extrabold">{isAlly && hostLeft ? "Host Disconnected" : "Plane Shot Down!"}</h2>
          <p className="text-lg">
            Score: <span className="font-bold">{score}</span>
          </p>
          {netRole !== "solo" && (
            <p className="text-sm text-white/70">
              Host: <span className="font-semibold text-white">{scores[0] ?? 0}</span> · Ally:{" "}
              <span className="font-semibold text-white">{scores[1] ?? 0}</span>
            </p>
          )}
          <p className="text-sm text-white/70">Best: {best}</p>
          {isAlly ? (
            <p className="text-sm text-white/70">Waiting for host…</p>
          ) : (
            <button
              onClick={handlePlayAgain}
              className="mt-1 rounded-full bg-red-600 px-8 py-3 text-base font-bold shadow-lg shadow-red-900/40 active:scale-95 transition-transform"
            >
              Play Again
            </button>
          )}
          <div className="flex gap-4">
            <button onClick={backToMenu} className="text-sm text-white/70 underline underline-offset-2">
              Main Menu
            </button>
            <button onClick={handleQuit} className="text-sm text-white/70 underline underline-offset-2">
              Quit Game
            </button>
          </div>
        </div>
      )}

      {status === "quit" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black/65 px-6 text-center text-white font-sans">
          <h2 className="text-3xl font-extrabold">Mission Debrief</h2>
          <p className="text-lg">
            Score: <span className="font-bold">{score}</span>
          </p>
          <p className="text-sm text-white/70">Best: {best}</p>
          <button
            onClick={backToMenu}
            className="mt-1 rounded-full bg-white/20 px-6 py-2.5 text-sm font-semibold"
          >
            Back to Menu
          </button>
        </div>
      )}
    </div>
  );
}
