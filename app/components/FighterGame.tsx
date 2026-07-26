"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
  type ChatMessage,
} from "../lib/coop";
import { createMusicPlayer, type MusicPlayer } from "../lib/musicPlayer";
import {
  playPageFlipSound,
  playEnemyHitSound,
  playShieldPickupSound,
  playRapidFireSound,
  playSmartBombPickupSound,
  primeAudioContext,
} from "../lib/sfx";
import AuthPanel, { type AuthUser, type AuthPanelHandle, type LeaderboardTop } from "./AuthPanel";

type Bullet = { x: number; y: number; vy: number; ownerId: string; rapid: boolean };
type Missile = { x: number; y: number; vy: number; vx: number };
type Bomb = { x: number; y: number; vy: number; rot: number };
type Shield = { x: number; y: number; vy: number; phase: number };
type RapidFire = { x: number; y: number; vy: number; phase: number };
type SmartBomb = { x: number; y: number; vy: number; phase: number };
type Enemy = {
  x: number;
  y: number;
  vy: number;
  phase: number;
  amp: number;
  scale: number;
  fireTimer: number;
  bombTimer: number;
  // Present only for the finale cluster: loops the plane continuously
  // around a fixed point instead of falling, so it never leaves the screen
  // on its own — it's there until the player shoots it down or time runs
  // out, not until it happens to drift off the bottom.
  orbit?: { cx: number; cy: number; radius: number; angle: number; speed: number };
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
type Star = { x: number; y: number; r: number; speed: number; opacity: number; twinklePhase: number };
// A handful of huge, barely-moving, very-low-opacity glow blobs far behind
// the stars — the near-static "background" layer that makes the fast
// foreground stars actually read as parallax depth instead of just noise.
type Nebula = { x: number; y: number; r: number; speed: number; color: string };

type Player = {
  id: string;
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  invuln: number;
  fireTimer: number;
  // Elapsed-time threshold (host-simulation-only, not networked — see the
  // note by RAPIDFIRE_DURATION) until which this plane fires faster.
  rapidFireUntil: number;
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
  shields: Shield[];
  rapidFires: RapidFire[];
  smartBombs: SmartBomb[];
  particles: Particle[];
  stars: Star[];
  nebulae: Nebula[];
  // Not networked — derived purely from `level`, which is already synced,
  // so the ally computes the identical theme locally.
  locationTheme: LocationTheme;
  // Host/solo-simulation-only (see perksForLocation) — the ally never runs
  // the fire loop itself, so this never needs to be networked.
  baseFireInterval: number;
  spawnTimer: number;
  shieldTimer: number;
  rapidFireTimer: number;
  smartBombTimer: number;
  elapsed: number;
  pointerDown: boolean;
  keys: Set<string>;
  // Host/solo-only simulation state for the halfway-mark "army incoming"
  // event — not networked, since the ally sees its effects (the extra
  // enemies, the bomb lull) purely through the normal snapshot sync.
  midpointWaveSpawned: boolean;
  bombsSuppressedUntil: number;
  // Same pattern for the final-15-seconds orbiting finale cluster. Slot
  // centers are fixed once the cluster spawns; finalRespawnTimer drives
  // topping up any slot a player clears out, so the cluster stays populated
  // for the whole window instead of running dry once destroyed.
  finalWaveSpawned: boolean;
  finalSlots: { cx: number; cy: number }[];
  finalRespawnTimer: number;
}

const PLAYER_RADIUS = 14;
const ENEMY_RADIUS = 15;
// Hitboxes are smaller than the sprites so near-misses look and feel fair.
const PLAYER_HIT_RADIUS = 7;
const ENEMY_HIT_RADIUS = 10;
const MISSILE_HIT_RADIUS = 3.5;
const BOMB_HIT_RADIUS = 4.5;
// Wider than a hazard hit-radius on purpose — a shield is a reward, not a
// threat, so near-misses while dodging should still count as a grab instead
// of demanding pixel-precise flying on top of everything else going on.
const SHIELD_HIT_RADIUS = 18;
const INVULN_TIME = 2.2;
// Each shield pickup is worth a fixed amount; once the running total crosses
// another multiple of SHIELD_PER_LIFE, one life is restored (capped at
// maxLives), so recovery is a steady drip rather than an instant refill.
const SHIELD_VALUE = 19;
const SHIELD_PER_LIFE = 40;

const RAPIDFIRE_HIT_RADIUS = 18;
// Normal fire interval is 0.18s; rapid fire roughly triples the rate for a
// limited window rather than being a permanent upgrade.
const RAPIDFIRE_INTERVAL = 0.06;
const RAPIDFIRE_DURATION = 8;

const SMARTBOMB_HIT_RADIUS = 18;

// A restored life also grants a brief "Healthy" invulnerability window, and
// that window grows the more total shields a run has collected — so staying
// shield-focused pays off with a longer safety margin each time you heal, not
// just an occasional extra life.
function healInvulnDuration(shieldTotal: number) {
  return clamp(2 + shieldTotal * 0.004, 2.5, 6);
}
const GRAVITY = 130;
// Solo games rotate through a pool of tracks (one picked at random each time
// a level starts) instead of looping the same one the whole run. Co-op
// always plays its own single track, since both players need to hear the
// same thing.
const SOLO_MUSIC_TRACKS = [
  "/audio/theme-solo-ente-evil.mp3",
  "/audio/theme-solo-megasong.mp3",
  "/audio/theme-solo-menace.mp3",
  "/audio/theme-solo-calamity.mp3",
  "/audio/theme-solo-devoted-guard.mp3",
];
function pickSoloMusicTrack(): string {
  return SOLO_MUSIC_TRACKS[Math.floor(Math.random() * SOLO_MUSIC_TRACKS.length)];
}
const COOP_MUSIC_TRACK = "/audio/theme-coop.mp3";
// Soft jazz piano plays while browsing the Locations screen — a strategy-map
// moment rather than gameplay, so it gets its own calmer track.
const LOCATIONS_MUSIC_TRACK = "/audio/theme-locations.mp3";
// Plays on the landing/menu screen itself, before any mode is started.
const MENU_MUSIC_TRACK = "/audio/theme-menu.mp3";
// One-tap co-op call-outs — the whole point is speed (typing while dodging
// isn't practical), so these cover it without ever needing the keyboard.
const CHAT_PRESETS = ["Watch out!", "Nice shot!", "Need help!", "Behind you!", "GG!"];
const CHAT_BUBBLE_DURATION = 3000;
// Pusher hard-caps client events at 10/sec per connection; staying well
// under that avoids events getting silently dropped (which reads as
// mounting lag that eventually "hangs" once updates stop arriving).
const BROADCAST_INTERVAL = 1 / 8;
const INPUT_SEND_INTERVAL = 1 / 8;
const MAX_SNAPSHOT_ENTITIES = 40;

// ---------------------------------------------------------------------
// Locations: every level is its own named "location" the player travels
// to. Endless and fully deterministic — the same location index always
// produces the same name and scenery, on host and ally alike, computed
// locally from the synced level number rather than sent over the network.
// ---------------------------------------------------------------------

function locationIndexForLevel(level: number): number {
  return level;
}

// A tiny seeded PRNG (mulberry32) so "the same location always looks the
// same" without needing to network any of this — both host and ally derive
// it purely from the location index.
function mulberry32(seed: number) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LOCATION_PREFIXES = [
  "Kepler", "Nebula", "Cryo", "Helix", "Vortex", "Ion", "Quantum", "Solaris",
  "Titan", "Nova", "Zenith", "Axiom", "Umbra", "Lumen", "Orbis", "Pulsar",
  "Magnetar", "Aether", "Photon", "Nexus", "Vega", "Draco", "Lyra", "Hadron", "Meridian",
];
const LOCATION_ROOTS = [
  "Drift", "Sector", "Vault", "Expanse", "Rift", "Cluster", "Belt", "Array",
  "Chasm", "Reach", "Zone", "Field", "Wake", "Spire", "Basin", "Corridor",
  "Gate", "Trench", "Bastion", "Verge",
];
const LOCATION_TAILS = [
  "Prime", "Theta", "Delta", "Omega", "IX", "VII", "XII", "Alpha", "Zero",
  "Sigma", "Epsilon", "X", "Core", "Null", "III",
];

function getLocationName(index: number): string {
  const rand = mulberry32(index * 7919 + 13);
  const p = LOCATION_PREFIXES[Math.floor(rand() * LOCATION_PREFIXES.length)];
  const r = LOCATION_ROOTS[Math.floor(rand() * LOCATION_ROOTS.length)];
  const t = LOCATION_TAILS[Math.floor(rand() * LOCATION_TAILS.length)];
  return `${p} ${r} ${t}`;
}

// Hand-curated, astrophotography-inspired palettes — deliberately muted and
// layered rather than flat saturated "cartoon" colors. Cycles every 8
// locations; planet placement and the horizon silhouette are separately
// randomized per location so even a repeated palette still looks distinct.
interface LocationPalette {
  sky: [string, string, string, string];
  nebulaTint: string;
  planetCore: string;
  planetEdge: string;
}
const LOCATION_PALETTES: LocationPalette[] = [
  { sky: ["#04050c", "#0a1024", "#131b3d", "#1c2550"], nebulaTint: "90,70,160", planetCore: "#cfd8e8", planetEdge: "#3a4468" },
  { sky: ["#0d0705", "#24100a", "#3e1810", "#5c2414"], nebulaTint: "200,90,50", planetCore: "#ffd9a8", planetEdge: "#6b2f14" },
  { sky: ["#030a12", "#082233", "#114058", "#1c5f74"], nebulaTint: "70,180,200", planetCore: "#d8f5ff", planetEdge: "#1c5f74" },
  { sky: ["#050b06", "#0b1f12", "#14371e", "#1f5029"], nebulaTint: "90,190,110", planetCore: "#d4ffd8", planetEdge: "#1f5029" },
  { sky: ["#08040f", "#180a28", "#2a1244", "#3d1a5e"], nebulaTint: "170,80,220", planetCore: "#ecd6ff", planetEdge: "#3d1a5e" },
  { sky: ["#0a0704", "#241708", "#3f2810", "#5c3c18"], nebulaTint: "220,170,70", planetCore: "#fff0c8", planetEdge: "#5c3c18" },
  { sky: ["#020203", "#0a0a10", "#14141e", "#1e1e2c"], nebulaTint: "120,120,160", planetCore: "#e8e8f0", planetEdge: "#1e1e2c" },
  { sky: ["#0a0508", "#22101a", "#3a1c2c", "#522a3e"], nebulaTint: "220,130,170", planetCore: "#ffe0ec", planetEdge: "#522a3e" },
];

interface LocationTheme {
  index: number;
  name: string;
  palette: LocationPalette;
  planet: { x: number; y: number; r: number; ring: boolean };
  // A smooth distant-mountain silhouette (sum of a few sine waves, not a
  // jagged random polyline) sampled into points once and reused every
  // frame — reads as a real horizon instead of noise.
  horizon: { x: number; y: number }[];
}

function getLocationTheme(index: number, width: number, height: number): LocationTheme {
  const rand = mulberry32(index * 104729 + 31);
  const palette = LOCATION_PALETTES[index % LOCATION_PALETTES.length];

  const planet = {
    x: rand() < 0.5 ? width * (0.08 + rand() * 0.12) : width * (0.8 + rand() * 0.12),
    y: height * (0.08 + rand() * 0.16),
    r: 55 + rand() * 65,
    ring: rand() < 0.35,
  };

  const amp1 = 18 + rand() * 22;
  const amp2 = 8 + rand() * 14;
  const freq1 = 0.006 + rand() * 0.006;
  const freq2 = 0.015 + rand() * 0.012;
  const phase1 = rand() * Math.PI * 2;
  const phase2 = rand() * Math.PI * 2;
  const baseY = height * (0.82 + rand() * 0.08);
  const horizon: { x: number; y: number }[] = [];
  const steps = 24;
  for (let i = 0; i <= steps; i++) {
    const x = (width * i) / steps;
    const y = baseY - Math.sin(x * freq1 + phase1) * amp1 - Math.sin(x * freq2 + phase2) * amp2;
    horizon.push({ x, y });
  }

  return { index, name: getLocationName(index), palette, planet, horizon };
}

// Auto-equip loadout: every 2 locations survived deeper unlocks a tougher
// plane automatically — no separate equip screen, the loadout is just a
// function of how far out you've proven you can fly. Capped so numbers stay
// sane at extreme depth rather than trivializing the game.
interface LocationPerks {
  extraLives: number;
  baseFireInterval: number;
  startingShieldValue: number;
  startingRapidFireBonus: number;
}

function perksForLocation(locationIndex: number): LocationPerks {
  const tier = Math.min(Math.floor((locationIndex - 1) / 2), 6);
  return {
    extraLives: tier,
    baseFireInterval: Math.max(0.1, 0.18 - tier * 0.012),
    startingShieldValue: tier * 10,
    startingRapidFireBonus: tier >= 2 ? 3 : 0,
  };
}

// Short human-readable badges for the perks a location grants, shown on its
// card in the Locations screen so the auto-equip loadout isn't invisible.
function perkSummary(locationIndex: number): string[] {
  const p = perksForLocation(locationIndex);
  const badges: string[] = [];
  if (p.extraLives > 0) badges.push(`+${p.extraLives} lives`);
  if (p.baseFireInterval < 0.18) badges.push("faster fire");
  if (p.startingShieldValue > 0) badges.push("shield head start");
  if (p.startingRapidFireBonus > 0) badges.push("rapid-fire start");
  return badges;
}

// ---------------------------------------------------------------------
// Locations screen geometry: a winding route through space (planet nodes
// linked by a smooth curved path) rather than a flat list — climbing from
// the start at the bottom toward the frontier and a preview of what's next
// at the top, the same "journey map" shape as a game roadmap.
// ---------------------------------------------------------------------
const PATH_WIDTH = 340;
const PATH_NODE_SPACING = 168;
const PATH_NODE_R = 30;
const PATH_TOP_PAD = 90;
const PATH_BOTTOM_PAD = 110;

// Smooth, non-mechanical left-right swing driven by a sine wave rather than
// a strict alternating zigzag — clamped well inside the container so the
// text callout centered under each node never clips off either edge.
function pathNodeX(seqIndex: number): number {
  const raw = PATH_WIDTH / 2 + Math.sin(seqIndex * 0.85 + 0.5) * 92;
  return clamp(raw, 85, PATH_WIDTH - 85);
}

// Catmull-Rom-to-Bezier conversion: turns a list of node centers into one
// smooth SVG path (rather than straight segments), matching the flowing
// curve look of a hand-drawn journey map.
function catmullRomPath(points: { x: number; y: number }[]): string {
  if (points.length < 2) return "";
  let d = `M ${points[0].x},${points[0].y}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${cp1x},${cp1y} ${cp2x},${cp2y} ${p2.x},${p2.y}`;
  }
  return d;
}

// Difficulty grows with the log of the level so early stages ramp up fast
// while the long tail (toward level 1000 and beyond) keeps climbing but
// never explodes.
// Log growth alone (the original curve) flattens out fast -- past the first
// few levels it barely moves, so a long campaign stopped feeling like it was
// climbing. From level 10 on, an added linear term keeps the ramp visibly
// spreading out deeper into the game instead of plateauing.
function levelDifficulty(level: number) {
  const base = Math.log2(level + 1) * 0.85;
  if (level <= 9) return base;
  return base + (level - 9) * 0.12;
}

// On top of level difficulty, a single playthrough gets tougher the longer
// you survive. This is a flat step, not a smooth curve: it holds steady for
// a full minute, then jumps by +0.5% — a continuous log-curve compounded too
// fast right before the time limit, spawning a flood of planes. Stepping by
// whole minutes keeps the ramp predictable, in solo, host, and ally games
// alike (ally sees it because the host is the one simulating and
// broadcasting it).
function timeDifficultyMultiplier(elapsed: number) {
  return 1 + Math.floor(elapsed / 60) * 0.005;
}

// Shield drops get more frequent the longer a run goes, mirroring the
// difficulty ramp so recovery keeps pace with the growing pressure — same
// flat-per-minute stepping, just shrinking the spawn interval instead of
// growing a difficulty score.
function shieldRateMultiplier(elapsed: number) {
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

// Widens the dead zone around each phase crossing into a real breather —
// used only for co-op's *extra* bomb/plane bonus on top of the base
// difficulty above, so a two-player game gets an actual lull between the
// bomb-heavy and plane-heavy stretches instead of the bonus always being at
// least partway on. Solo pacing (which reads bombFocus/swarmFocus directly)
// is untouched by this.
function coopBonusIntensity(focus: number) {
  return clamp((focus - 0.3) / 0.7, 0, 1);
}

// How long a level requires surviving to clear it: level 1 is a full 3
// minutes, growing slowly and capping so a long campaign stays a
// long-term goal rather than an ever-longer marathon.
function levelSurviveDuration(level: number) {
  return clamp(180 + (level - 1) * 4, 180, 300);
}

// A symmetric wedge of relative {dx, dy} offsets for a burst of n enemies,
// wide and trailing at the edges, nose-first in the middle — reads as a
// squadron arriving in formation rather than a scatter of random spawns.
// Enemies still fall independently straight down after spawning; only the
// initial burst shape is formation-like.
function wedgeFormation(n: number, spacing: number, dropStep: number): { dx: number; dy: number }[] {
  const half = (n - 1) / 2;
  return Array.from({ length: n }, (_, i) => {
    const k = i - half;
    return { dx: k * spacing, dy: -Math.abs(k) * dropStep };
  });
}

// A dense, brick-staggered grid burst — the "an army of enemy planes" event
// at a level's halfway mark, visually distinct from the small wedge bursts
// that spawn the rest of the time. Rear rows are shifted further back so the
// whole block reads as arriving together rather than a single flat rank.
function gridFormation(rows: number, cols: number, spacingX: number, spacingY: number): { dx: number; dy: number }[] {
  const halfCols = (cols - 1) / 2;
  const offsets: { dx: number; dy: number }[] = [];
  for (let r = 0; r < rows; r++) {
    const rowStagger = r % 2 === 1 ? spacingX / 2 : 0;
    for (let c = 0; c < cols; c++) {
      offsets.push({ dx: (c - halfCols) * spacingX + rowStagger, dy: -r * spacingY });
    }
  }
  return offsets;
}

function makePlayers(
  width: number,
  height: number,
  playerIds: string[],
  startingRapidFireBonus: number
): Player[] {
  const n = playerIds.length;
  return playerIds.map((id, i) => {
    const x = width / 2 + (i - (n - 1) / 2) * 56;
    const y = height - height * 0.16;
    return { id, x, y, targetX: x, targetY: y, invuln: 2, fireTimer: 0, rapidFireUntil: startingRapidFireBonus };
  });
}

function makeInitialState(width: number, height: number, level: number, playerIds: string[]): GameState {
  // Size, speed, and brightness all driven off the same random "depth" so
  // they stay consistent with each other — a star that's bigger and
  // brighter also moves faster, exactly like something genuinely closer to
  // the camera would, instead of those three cues fighting each other.
  const stars: Star[] = Array.from({ length: 70 }, () => {
    const depth = Math.random();
    return {
      x: Math.random() * width,
      y: Math.random() * height,
      r: 0.5 + depth * 1.8,
      speed: 16 + depth * 75,
      opacity: 0.25 + depth * 0.65,
      twinklePhase: Math.random() * Math.PI * 2,
    };
  });
  const locationTheme = getLocationTheme(locationIndexForLevel(level), width, height);
  const perks = perksForLocation(locationTheme.index);
  // A few tonal variations on the location's own tint, rather than
  // unrelated random colors, so the nebula layer reads as part of the same
  // scene instead of clashing with it.
  const tintChannels = locationTheme.palette.nebulaTint.split(",").map(Number);
  const nebulaColors = [-20, 0, 20].map((delta) =>
    tintChannels.map((c) => clamp(c + delta, 0, 255)).join(",")
  );
  const nebulae: Nebula[] = Array.from({ length: 3 }, () => ({
    x: Math.random() * width,
    y: Math.random() * height,
    r: 140 + Math.random() * 100,
    speed: 3 + Math.random() * 5,
    color: nebulaColors[Math.floor(Math.random() * nebulaColors.length)],
  }));
  return {
    width,
    height,
    level,
    levelDuration: levelSurviveDuration(level),
    players: makePlayers(width, height, playerIds, perks.startingRapidFireBonus),
    bullets: [],
    missiles: [],
    bombs: [],
    enemies: [],
    shields: [],
    rapidFires: [],
    smartBombs: [],
    particles: [],
    stars,
    nebulae,
    locationTheme,
    baseFireInterval: perks.baseFireInterval,
    spawnTimer: 0.6,
    shieldTimer: 2 + Math.random() * 2,
    rapidFireTimer: 12 + Math.random() * 6,
    smartBombTimer: 22 + Math.random() * 10,
    elapsed: 0,
    pointerDown: false,
    keys: new Set(),
    midpointWaveSpawned: false,
    bombsSuppressedUntil: 0,
    finalWaveSpawned: false,
    finalSlots: [],
    finalRespawnTimer: 0,
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

// A tight core plus a soft glow halo, so stars read as small points of light
// rather than flat dots, and brighter ones feel like they're glowing.
function drawStar(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, opacity: number) {
  const glow = ctx.createRadialGradient(x, y, 0, x, y, r * 4);
  glow.addColorStop(0, `rgba(210,230,255,${opacity * 0.5})`);
  glow.addColorStop(1, "rgba(210,230,255,0)");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(x, y, r * 4, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = `rgba(255,255,255,${opacity})`;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
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

// The fuselage outline is identical on every call (only fill color and
// ctx.scale differ) — built lazily once on first use (not at module top
// level, so this stays safe if the module is ever touched outside a
// browser) and reused from then on, instead of re-issuing the same ~18
// path commands into a brand new Path2D every single jet, every frame.
let fuselagePathCache: Path2D | null = null;
function getFuselagePath(): Path2D {
  if (fuselagePathCache) return fuselagePathCache;
  const fuselage = new Path2D();
  fuselage.moveTo(0, -24);
  fuselage.bezierCurveTo(3, -21, 5, -15, 5, -8);
  fuselage.lineTo(19, 3);
  fuselage.lineTo(20.5, 7.5);
  fuselage.lineTo(6, 6.5);
  fuselage.lineTo(7, 15.5);
  fuselage.lineTo(13.5, 19.5);
  fuselage.lineTo(4, 18.5);
  fuselage.lineTo(3.2, 23.5);
  fuselage.lineTo(-3.2, 23.5);
  fuselage.lineTo(-4, 18.5);
  fuselage.lineTo(-13.5, 19.5);
  fuselage.lineTo(-7, 15.5);
  fuselage.lineTo(-6, 6.5);
  fuselage.lineTo(-20.5, 7.5);
  fuselage.lineTo(-19, 3);
  fuselage.lineTo(-5, -8);
  fuselage.bezierCurveTo(-5, -15, -3, -21, 0, -24);
  fuselage.closePath();
  fuselagePathCache = fuselage;
  return fuselage;
}

// A soft, fixed-direction drop shadow — drawn before any bank rotation is
// applied to the jet above it, so the shadow stays "cast on a surface
// behind the plane" instead of rotating with it. That fixed offset against
// a rotating sprite is what sells the sprite as floating above something
// rather than being flat against the background.
function drawJetShadow(ctx: CanvasRenderingContext2D, scale: number) {
  ctx.save();
  ctx.scale(scale, scale);
  const grad = ctx.createRadialGradient(3, 9, 0, 3, 9, 17);
  grad.addColorStop(0, "rgba(0,0,0,0.4)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.ellipse(3, 9, 15, 8, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
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

  // Fuselage + delta wings + tail silhouette — the same cached Path2D is
  // reused below as a clip region for the cross-body highlight/shadow pass:
  // a light-from-one-side gradient confined to the fuselage, which is what
  // turns a flat-shaded silhouette into something that reads as a rounded,
  // lit 3D body instead of a paper cutout.
  const grad = ctx.createLinearGradient(0, -24, 0, 24);
  grad.addColorStop(0, scheme.bodyTop);
  grad.addColorStop(1, scheme.bodyBottom);

  const fuselage = getFuselagePath();
  ctx.fillStyle = grad;
  ctx.fill(fuselage);
  ctx.lineWidth = 0.7;
  ctx.strokeStyle = scheme.stroke;
  ctx.stroke(fuselage);

  // clip() confines this fill to the fuselage shape correctly. (An earlier
  // attempt used globalCompositeOperation "source-atop" as a cheaper
  // alternative, but that composites against the *entire* canvas drawn so
  // far — not just this shape — so it painted a visible rectangle instead
  // of staying inside the silhouette. clip() is the correct tool here.)
  ctx.save();
  ctx.clip(fuselage);
  const volumeGrad = ctx.createLinearGradient(-9, 0, 9, 0);
  volumeGrad.addColorStop(0, "rgba(255,255,255,0.42)");
  volumeGrad.addColorStop(0.32, "rgba(255,255,255,0.12)");
  volumeGrad.addColorStop(0.55, "rgba(0,0,0,0)");
  volumeGrad.addColorStop(1, "rgba(0,0,0,0.35)");
  ctx.fillStyle = volumeGrad;
  ctx.fillRect(-24, -26, 48, 52);
  ctx.restore();

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

// Draws a preloaded plane sprite centered at the local origin, nose "up"
// before rotation/scale is applied by the caller -- same calling convention
// as drawJet, so the two are drop-in alternatives at each call site.
// Returns false (drawing nothing) if the image hasn't finished loading yet,
// so callers can fall back to the vector jet for that one frame.
function drawJetSprite(ctx: CanvasRenderingContext2D, img: HTMLImageElement | undefined, scale: number): boolean {
  if (!img || !img.complete || img.naturalWidth === 0) return false;
  const height = 46;
  const width = height * (img.naturalWidth / img.naturalHeight);
  ctx.save();
  ctx.scale(scale, scale);
  ctx.drawImage(img, -width / 2, -height / 2, width, height);
  ctx.restore();
  return true;
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

function drawShield(ctx: CanvasRenderingContext2D, shine: number) {
  ctx.save();

  // soft energy glow behind the shield
  const glow = ctx.createRadialGradient(0, 0, 2, 0, 0, 15);
  glow.addColorStop(0, "rgba(90,210,255,0.55)");
  glow.addColorStop(1, "rgba(90,210,255,0)");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(0, 0, 15, 0, Math.PI * 2);
  ctx.fill();

  // heater-shield silhouette: rounded top tapering to a point
  const shieldPath = () => {
    ctx.beginPath();
    ctx.moveTo(-8, -7);
    ctx.bezierCurveTo(-8, -11, 8, -11, 8, -7);
    ctx.lineTo(8, 2);
    ctx.quadraticCurveTo(8, 6, 0, 11);
    ctx.quadraticCurveTo(-8, 6, -8, 2);
    ctx.closePath();
  };

  shieldPath();
  const bodyGrad = ctx.createLinearGradient(0, -11, 0, 11);
  bodyGrad.addColorStop(0, "#c8f4ff");
  bodyGrad.addColorStop(0.45, "#4fc3f7");
  bodyGrad.addColorStop(1, "#0d6fa8");
  ctx.fillStyle = bodyGrad;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = "#0a3d5c";
  ctx.stroke();

  // inner rim for a layered, plated look
  ctx.beginPath();
  ctx.moveTo(-5, -6);
  ctx.bezierCurveTo(-5, -8.5, 5, -8.5, 5, -6);
  ctx.lineTo(5, 1);
  ctx.quadraticCurveTo(5, 4, 0, 7.5);
  ctx.quadraticCurveTo(-5, 4, -5, 1);
  ctx.closePath();
  ctx.strokeStyle = "rgba(255,255,255,0.55)";
  ctx.lineWidth = 0.7;
  ctx.stroke();

  // heal/restore cross emblem
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.fillRect(-1.1, -4.2, 2.2, 8.4);
  ctx.fillRect(-4.2, -1.1, 8.4, 2.2);

  // soft rotating glint so it reads as energized while falling
  ctx.globalAlpha = 0.5 + shine * 0.3;
  ctx.beginPath();
  ctx.ellipse(-3 + shine * 4, -6, 2, 0.9, -0.5, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.fill();
  ctx.restore();
}

function drawRapidFire(ctx: CanvasRenderingContext2D, shine: number) {
  ctx.save();

  const glow = ctx.createRadialGradient(0, 0, 2, 0, 0, 15);
  glow.addColorStop(0, "rgba(255,210,60,0.55)");
  glow.addColorStop(1, "rgba(255,210,60,0)");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(0, 0, 15, 0, Math.PI * 2);
  ctx.fill();

  ctx.beginPath();
  ctx.arc(0, 0, 10, 0, Math.PI * 2);
  const bodyGrad = ctx.createLinearGradient(0, -10, 0, 10);
  bodyGrad.addColorStop(0, "#fff3b0");
  bodyGrad.addColorStop(0.45, "#ffb833");
  bodyGrad.addColorStop(1, "#c9660a");
  ctx.fillStyle = bodyGrad;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = "#7a3a02";
  ctx.stroke();

  // lightning-bolt emblem
  ctx.beginPath();
  ctx.moveTo(1.5, -7);
  ctx.lineTo(-4, 0.5);
  ctx.lineTo(-0.5, 0.5);
  ctx.lineTo(-1.5, 7);
  ctx.lineTo(4.5, -1);
  ctx.lineTo(1, -1);
  ctx.closePath();
  ctx.fillStyle = "rgba(255,255,255,0.95)";
  ctx.fill();
  ctx.strokeStyle = "rgba(122,58,2,0.5)";
  ctx.lineWidth = 0.5;
  ctx.stroke();

  ctx.globalAlpha = 0.5 + shine * 0.3;
  ctx.beginPath();
  ctx.ellipse(-3 + shine * 4, -6, 2, 0.9, -0.5, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.fill();
  ctx.restore();
}

function drawSmartBomb(ctx: CanvasRenderingContext2D, shine: number) {
  ctx.save();

  const glow = ctx.createRadialGradient(0, 0, 2, 0, 0, 17);
  glow.addColorStop(0, "rgba(255,80,60,0.55)");
  glow.addColorStop(1, "rgba(255,80,60,0)");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(0, 0, 17, 0, Math.PI * 2);
  ctx.fill();

  ctx.beginPath();
  ctx.arc(0, 0, 10, 0, Math.PI * 2);
  const bodyGrad = ctx.createLinearGradient(0, -10, 0, 10);
  bodyGrad.addColorStop(0, "#ffc9b0");
  bodyGrad.addColorStop(0.45, "#ff5a3c");
  bodyGrad.addColorStop(1, "#8a0f0f");
  ctx.fillStyle = bodyGrad;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = "#5c0a0a";
  ctx.stroke();

  // radiating burst spikes — a "clear the screen" symbol
  ctx.fillStyle = "rgba(255,255,255,0.95)";
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    ctx.save();
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(0, -2.4);
    ctx.lineTo(1.6, -8.5);
    ctx.lineTo(0, -6.4);
    ctx.lineTo(-1.6, -8.5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  ctx.beginPath();
  ctx.arc(0, 0, 2.6, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,255,255,0.95)";
  ctx.fill();

  ctx.globalAlpha = 0.4 + shine * 0.3;
  ctx.beginPath();
  ctx.ellipse(-3 + shine * 4, -6, 2, 0.9, -0.5, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,255,255,0.8)";
  ctx.fill();
  ctx.restore();
}

// A chunky glowing energy bolt rather than a thin spark — reads as a much
// heavier weapon while staying the same size for collision purposes (the
// hitbox is still driven by the target's radius, not the bullet's). Swaps to
// a green palette while Rapid Fire is active, so the buff reads clearly in
// the middle of a firefight instead of just being a faster version of the
// same look.
function drawBullet(ctx: CanvasRenderingContext2D, rapid: boolean) {
  ctx.save();

  const trailC = rapid ? "80,255,140" : "255,180,80";
  const trailCEnd = rapid ? "60,255,110" : "255,120,30";
  const glowC = rapid ? "150,255,170" : "255,205,100";
  const glowCEnd = rapid ? "70,255,120" : "255,140,40";
  const strokeC = rapid ? "rgba(30,140,60,0.5)" : "rgba(180,70,10,0.5)";

  // Long tapering exhaust trail behind the bolt (it travels toward -y, so
  // the trail extends toward +y) — reads as high-velocity ordnance rather
  // than a plinking spark.
  const trail = ctx.createLinearGradient(0, 6, 0, 22);
  trail.addColorStop(0, `rgba(${trailC},0.55)`);
  trail.addColorStop(1, `rgba(${trailCEnd},0)`);
  ctx.fillStyle = trail;
  ctx.beginPath();
  ctx.moveTo(-2.4, 6);
  ctx.lineTo(2.4, 6);
  ctx.lineTo(0, 22);
  ctx.closePath();
  ctx.fill();

  const glow = ctx.createRadialGradient(0, -3, 1, 0, -3, 16);
  glow.addColorStop(0, `rgba(${glowC},0.6)`);
  glow.addColorStop(1, `rgba(${glowCEnd},0)`);
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.ellipse(0, -3, 10, 18, 0, 0, Math.PI * 2);
  ctx.fill();

  const grad = ctx.createLinearGradient(0, -16, 0, 9);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  if (rapid) {
    grad.addColorStop(0.3, "rgba(190,255,150,1)");
    grad.addColorStop(0.7, "rgba(50,220,90,0.95)");
    grad.addColorStop(1, "rgba(20,160,60,0.2)");
  } else {
    grad.addColorStop(0.3, "rgba(255,222,130,1)");
    grad.addColorStop(0.7, "rgba(255,120,30,0.95)");
    grad.addColorStop(1, "rgba(255,70,15,0.2)");
  }
  ctx.beginPath();
  ctx.moveTo(0, -16);
  ctx.lineTo(4, -6);
  ctx.lineTo(3.4, 6);
  ctx.lineTo(0, 9);
  ctx.lineTo(-3.4, 6);
  ctx.lineTo(-4, -6);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.strokeStyle = strokeC;
  ctx.lineWidth = 0.6;
  ctx.stroke();

  ctx.strokeStyle = "rgba(255,255,255,0.95)";
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(0, -13);
  ctx.lineTo(0, 6);
  ctx.stroke();

  ctx.restore();
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

// A solid red hull (rather than the old grey body with just a red trim)
// reads as clearly hostile at a glance — the roundel/accent details flip to
// dark/near-black so they still stand out against the red instead of
// disappearing into it.
const ENEMY_SCHEME = {
  bodyTop: "#f2564a",
  bodyBottom: "#7a1210",
  stroke: "#2a0605",
  canopyTop: "#ffcdb8",
  canopyBottom: "#5c1210",
  roundelOuter: "#1c1c1c",
  roundelInner: "#f0f0f0",
  accent: "#f0f0f0",
};

// Toggle for the illustrated plane sprites vs. the original hand-drawn
// vector jets above -- flip this back to false to instantly revert to the
// vector look (the vector code is left fully intact for exactly that).
const USE_PLANE_SPRITES = true;
// Sprite art is nose-up already (matches drawJet's own local-space
// convention), so the same rotation the vector path uses for enemies
// (rotate(PI) to flip nose-down) and for player bank still applies as-is.
const PLANE_SPRITES = {
  blue: "/sprites/blueplane.webp",
  green: "/sprites/greenplane.webp",
  red: "/sprites/redplane.webp",
};
// players[] index -> sprite, same mapping PLAYER_SCHEMES uses (index 0 is
// always the host's plane, index 1 the ally's, regardless of which device
// is viewing).
const PLAYER_SPRITE_KEYS: (keyof typeof PLANE_SPRITES)[] = ["blue", "green"];

function readStoredBest(): number {
  if (typeof window === "undefined") return 0;
  try {
    return parseInt(window.localStorage.getItem("skyfighter-best") ?? "0", 10) || 0;
  } catch {
    return 0;
  }
}

const UNLOCKED_LEVEL_KEY = "skyfighter-unlocked-level";

function readStoredUnlockedLevel(): number {
  if (typeof window === "undefined") return 1;
  try {
    return Math.max(1, parseInt(window.localStorage.getItem(UNLOCKED_LEVEL_KEY) ?? "1", 10) || 1);
  } catch {
    return 1;
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
  const musicPlayerRef = useRef<MusicPlayer | null>(null);
  // Preloaded once on mount so the render loop's drawImage calls never pay a
  // decode cost mid-game -- plain HTMLImageElements are enough here (no
  // canvas needed for decoding), and each file is small (~25-35KB webp).
  const jetImagesRef = useRef<Partial<Record<keyof typeof PLANE_SPRITES, HTMLImageElement>>>({});
  // Purely a rendering-layer effect (not gameplay state, not networked):
  // each client tracks its own previous-frame x per player id and eases
  // toward a bank angle from the horizontal delta, so planes visibly lean
  // into turns instead of sliding around perfectly upright.
  const playerLastXRef = useRef<Map<string, number>>(new Map());
  const playerBankRef = useRef<Map<string, number>>(new Map());

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
  // Latest chat message per player id, keyed by id so only the most recent
  // one shows (a speech bubble over that player's plane, not a running
  // log) — expires on its own via `until`, no explicit cleanup needed.
  const chatBubblesRef = useRef<Map<string, { text: string; until: number }>>(new Map());

  const [status, setStatus] = useState<Status>("ready");
  const [score, setScore] = useState(0);
  // Per-player scores, index-aligned with playerIdsRef.current / s.players
  // (index 0 is always whoever started the game — the host in co-op, the
  // solo player otherwise; index 1, when present, is their ally).
  const [scores, setScores] = useState<number[]>([0]);
  const scoresRef = useRef<number[]>([0]);
  const [lives, setLives] = useState(3);
  const [maxLives, setMaxLives] = useState(3);
  const [shieldTotal, setShieldTotal] = useState(0);
  const [hostLeft, setHostLeft] = useState(false);

  // Kept in refs so the game-loop closure (created once) can read the
  // latest score/lives/shields when building a host broadcast snapshot.
  const scoreRef = useRef(score);
  const livesRef = useRef(lives);
  const maxLivesRef = useRef(maxLives);
  const shieldTotalRef = useRef(shieldTotal);
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
    shieldTotalRef.current = shieldTotal;
  }, [shieldTotal]);
  // Seeded with an SSR-safe default (matching the server-rendered markup) and
  // synced from localStorage in a mount effect below, to avoid a hydration
  // mismatch for returning players whose real best score differs from this.
  const [best, setBest] = useState(0);
  // Highest level ever survived — persisted to localStorage, this is the
  // "frontier" location the Locations screen unlocks up to. soloStartLevel
  // is the level the *next* solo run actually begins at: it defaults to the
  // frontier but can be pulled back to an earlier, already-unlocked location
  // for a deliberate replay without losing progress.
  const [unlockedLevel, setUnlockedLevel] = useState(1);
  const [soloStartLevel, setSoloStartLevel] = useState(1);
  const [justUnlockedLocation, setJustUnlockedLocation] = useState<string | null>(null);
  const [showLocations, setShowLocations] = useState(false);
  // Set when opening the map to reveal a location the player just unlocked
  // (rather than the plain "browse from the HUD" case) — the map scrolls to
  // and blinks this node instead of the frontier.
  const [highlightLocation, setHighlightLocation] = useState<number | null>(null);
  // Brief tap-feedback glow on a roadmap node — set on tap, cleared once the
  // short flip-sound/glow beat has played and the run actually launches.
  const [tappedLocation, setTappedLocation] = useState<number | null>(null);
  const locationsScrollRef = useRef<HTMLDivElement | null>(null);

  const [showChat, setShowChat] = useState(false);
  const [chatInput, setChatInput] = useState("");

  const [lobbyMode, setLobbyMode] = useState<LobbyMode>("solo");
  const [netRole, setNetRole] = useState<NetRole>("solo");
  const [roomCode, setRoomCode] = useState("");
  const [joinCodeInput, setJoinCodeInput] = useState("");
  const [connStatus, setConnStatus] = useState<ConnStatus>("idle");
  const [connError, setConnError] = useState("");
  const [teammateIds, setTeammateIds] = useState<string[]>([]);

  const [user, setUser] = useState<AuthUser | null>(null);
  const authPanelRef = useRef<AuthPanelHandle | null>(null);
  const userRef = useRef<AuthUser | null>(null);
  const [refreshLeaderboardKey, setRefreshLeaderboardKey] = useState(0);
  const [globalTop, setGlobalTop] = useState<LeaderboardTop | null>(null);
  // True while the sign-up/log-in form has unsubmitted nickname/password
  // text sitting in it — Start is held off until the player either finishes
  // that (so their score doesn't silently end up on a guest session) or
  // clears the fields to play as a guest on purpose.
  const [authPending, setAuthPending] = useState(false);
  const authPendingRef = useRef(false);
  useEffect(() => {
    authPendingRef.current = authPending;
  }, [authPending]);

  const [musicMuted, setMusicMuted] = useState(false);
  // Some mobile/in-app browsers silently swallow a play() call even from a
  // seemingly valid gesture (stricter than the standard autoplay spec) --
  // this is a guaranteed-to-work fallback: a real button the player taps
  // directly, shown only for as long as the menu track isn't actually
  // audible yet.
  const [showSoundPrompt, setShowSoundPrompt] = useState(false);

  useEffect(() => {
    localIdRef.current = getClientId();
  }, []);

  useEffect(() => {
    musicPlayerRef.current = createMusicPlayer();
    return () => {
      musicPlayerRef.current?.dispose();
      musicPlayerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!USE_PLANE_SPRITES) return;
    for (const key of Object.keys(PLANE_SPRITES) as (keyof typeof PLANE_SPRITES)[]) {
      const img = new Image();
      img.src = PLANE_SPRITES[key];
      jetImagesRef.current[key] = img;
    }
  }, []);

  useEffect(() => {
    musicPlayerRef.current?.setMuted(musicMuted);
  }, [musicMuted]);

  useEffect(() => {
    if (showLocations) {
      musicPlayerRef.current?.start(LOCATIONS_MUSIC_TRACK);
    } else if (status === "ready") {
      musicPlayerRef.current?.start(MENU_MUSIC_TRACK);
    }
  }, [showLocations, status]);

  // Autoplay is blocked until the page has seen a real user gesture, so the
  // menu track (which should start playing before anyone has clicked
  // anything) can't rely on the effect above alone. Deliberately NOT
  // `{ once: true }`: calling start() again while already playing is a
  // harmless no-op (setTrack skips re-assigning the same src), so it's safer
  // to keep retrying on every early gesture than to bet on the very first
  // one landing inside the browser's gesture window.
  useEffect(() => {
    const tryResumeMenuMusic = () => {
      primeAudioContext();
      if (statusRef.current === "ready") {
        musicPlayerRef.current?.start(MENU_MUSIC_TRACK);
      }
    };
    window.addEventListener("pointerdown", tryResumeMenuMusic, { capture: true });
    window.addEventListener("keydown", tryResumeMenuMusic, { capture: true });
    window.addEventListener("touchstart", tryResumeMenuMusic, { capture: true });
    return () => {
      window.removeEventListener("pointerdown", tryResumeMenuMusic, { capture: true });
      window.removeEventListener("keydown", tryResumeMenuMusic, { capture: true });
      window.removeEventListener("touchstart", tryResumeMenuMusic, { capture: true });
    };
  }, []);

  // Polls whether the menu track is actually audible while on the ready
  // screen, and surfaces the manual "Enable Sound" button whenever it
  // isn't -- catches the case where every gesture-based unlock attempt
  // above still didn't work (seen on some in-app/mobile browsers).
  useEffect(() => {
    // Nothing to poll outside the ready screen -- the button itself is
    // already gated on status/showLocations at render time, so there's no
    // need to separately reset the flag here.
    if (status !== "ready" || showLocations) return;
    const check = () => {
      setShowSoundPrompt(!musicPlayerRef.current?.isPlaying());
    };
    check();
    const id = setInterval(check, 800);
    return () => clearInterval(id);
  }, [status, showLocations]);

  useEffect(() => {
    // Reads localStorage after hydration (not in the initial state) so the
    // client's first render matches the server's SSR-safe default.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBest(readStoredBest());
    const u = readStoredUnlockedLevel();
    setUnlockedLevel(u);
    setSoloStartLevel(u);
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

  const beginGame = (role: NetRole, playerIds: string[], level: number = 1) => {
    netRoleRef.current = role;
    setNetRole(role);
    playerIdsRef.current = playerIds;
    setHostLeft(false);
    const el = containerRef.current;
    const width = el?.clientWidth ?? 360;
    const height = el?.clientHeight ?? 640;
    stateRef.current = makeInitialState(width, height, level, playerIds);
    localPosRef.current = null;
    const spawnedLocal = stateRef.current.players.find((p) => p.id === localIdRef.current);
    if (spawnedLocal) {
      localTargetRef.current = { x: spawnedLocal.x, y: spawnedLocal.y };
    }
    setScore(0);
    scoreRef.current = 0;
    scoresRef.current = playerIds.map(() => 0);
    setScores(scoresRef.current);
    const perks = perksForLocation(locationIndexForLevel(level));
    const total = 3 + (playerIds.length - 1) + perks.extraLives;
    setMaxLives(total);
    maxLivesRef.current = total;
    setLives(total);
    livesRef.current = total;
    setShieldTotal(perks.startingShieldValue);
    shieldTotalRef.current = perks.startingShieldValue;
    // Set synchronously (not just via the status-syncing effect) so the
    // game-loop closure never reads a stale ref for the one tick between
    // this call and the next React commit.
    statusRef.current = "playing";
    setStatus("playing");
    musicPlayerRef.current?.start(role === "solo" ? pickSoloMusicTrack() : COOP_MUSIC_TRACK);
  };

  const startSolo = (level: number = soloStartLevel) => {
    setJustUnlockedLocation(null);
    setSoloStartLevel(level);
    beginGame("solo", [localIdRef.current], level);
  };

  const hostRoom = () => {
    musicPlayerRef.current?.unlock(COOP_MUSIC_TRACK);
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
    channel.bind("client-chat", (data: ChatMessage) => {
      chatBubblesRef.current.set(data.id, { text: data.text, until: performance.now() + CHAT_BUBBLE_DURATION });
    });
  };

  const hostStartOrRestart = () => {
    const ids = [localIdRef.current, ...teammateIds].slice(0, MAX_PLAYERS);
    channelRef.current?.trigger("client-start", { level: 1, playerIds: ids } satisfies StartMessage);
    beginGame("host", ids);
  };

  const joinRoom = (code: string) => {
    musicPlayerRef.current?.unlock(COOP_MUSIC_TRACK);
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
    channel.bind("client-chat", (data: ChatMessage) => {
      chatBubblesRef.current.set(data.id, { text: data.text, until: performance.now() + CHAT_BUBBLE_DURATION });
    });
    channel.bind("pusher:member_removed", (member: { id: string }) => {
      if (netRoleRef.current === "ally" && member.id === playerIdsRef.current[0]) {
        setHostLeft(true);
        statusRef.current = "gameover";
        setStatus("gameover");
        musicPlayerRef.current?.stop();
      }
    });
  };

  // Shows immediately on the sender's own screen (Pusher client events don't
  // echo back to the sender) and closes the picker right away -- one tap is
  // the entire interaction, nothing lingers waiting to be dismissed.
  const sendChat = (text: string) => {
    const trimmed = text.trim().slice(0, 40);
    if (!trimmed || !channelRef.current) return;
    channelRef.current.trigger("client-chat", { id: localIdRef.current, text: trimmed } satisfies ChatMessage);
    // Only ever runs from a click handler, never during render.
    // eslint-disable-next-line react-hooks/purity
    chatBubblesRef.current.set(localIdRef.current, { text: trimmed, until: performance.now() + CHAT_BUBBLE_DURATION });
    setChatInput("");
    setShowChat(false);
  };

  const handleStart = () => {
    if (authPending) return;
    // Single Player opens the map instead of launching straight in --
    // picking a location (or tapping the frontier one) is what actually
    // starts the run. Co-op is unaffected: it isn't location-based.
    if (lobbyMode === "solo") setShowLocations(true);
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
    statusRef.current = "ready";
    setStatus("ready");
    // Started synchronously here (inside the click handler) rather than left
    // to the status-reactive effect -- some mobile browsers only honor
    // audio.play() when it's tied directly to the gesture's own call stack.
    musicPlayerRef.current?.start(MENU_MUSIC_TRACK);
  };

  const handleQuit = () => {
    resetLobby();
    statusRef.current = "quit";
    setStatus("quit");
    musicPlayerRef.current?.stop();
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
      if (statusRef.current === "ready" && !authPendingRef.current) {
        if (lobbyModeRef.current === "solo") startSolo();
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
      // This listener is on window, so without this guard, typing into the
      // sign-up form's nickname/password fields (which can easily contain
      // w/a/s/d or arrow characters) would both steer the plane and
      // auto-start a solo game mid-typing, well before Start is pressed.
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      const keys = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "w", "a", "s", "d", "W", "A", "S", "D"];
      if (keys.includes(e.key)) {
        e.preventDefault();
        stateRef.current?.keys.add(e.key.toLowerCase());
        if (statusRef.current === "ready" && !authPendingRef.current) {
          if (lobbyModeRef.current === "solo") startSolo();
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
              const prevSnap = appliedSnapshotRef.current;
              applySnapshot(s, latestSnapshotRef.current);
              appliedSnapshotRef.current = latestSnapshotRef.current;
              // No extra network messages for this -- score and shieldTotal
              // are already part of every broadcast snapshot, so a rise in
              // either since the last one we applied is a free, zero-latency
              // signal that a kill/pickup happened, without needing the
              // ally to run the host's simulation.
              if (prevSnap) {
                if (latestSnapshotRef.current.score > prevSnap.score) playEnemyHitSound();
                if (latestSnapshotRef.current.shieldTotal > prevSnap.shieldTotal) playShieldPickupSound();
                const gotRapidFire = latestSnapshotRef.current.players.some((pl) => {
                  const prevPl = prevSnap.players.find((p) => p.id === pl.id);
                  return prevPl && pl.rapidFireUntil > prevPl.rapidFireUntil;
                });
                if (gotRapidFire) playRapidFireSound();
              }
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
      // Purely decorative background layers — never networked, so each
      // client just drifts its own local copy every frame regardless of
      // role, instead of only moving on the host/solo simulation tick.
      for (const st of s.stars) {
        st.y += st.speed * dt;
        st.twinklePhase += dt * 3;
        if (st.y - st.r > s.height) {
          st.y = -st.r;
          st.x = Math.random() * s.width;
        }
      }
      for (const nb of s.nebulae) {
        nb.y += nb.speed * dt;
        if (nb.y - nb.r > s.height) {
          nb.y = -nb.r;
          nb.x = Math.random() * s.width;
        }
      }
      for (const pl of s.players) {
        if (pl.id === localIdRef.current) continue;
        pl.x += (pl.targetX - pl.x) * Math.min(1, dt * 10);
        pl.y += (pl.targetY - pl.y) * Math.min(1, dt * 10);
      }
      for (const en of s.enemies) {
        if (en.orbit) {
          en.orbit.angle += en.orbit.speed * dt;
          en.x = clamp(en.orbit.cx + Math.cos(en.orbit.angle) * en.orbit.radius, 20, s.width - 20);
          en.y = en.orbit.cy + Math.sin(en.orbit.angle) * en.orbit.radius;
        } else {
          en.y += en.vy * dt;
          en.phase += dt * 1.6;
          en.x = clamp(en.x + Math.sin(en.phase) * en.amp * dt * 0.6, 20, s.width - 20);
        }
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
      for (const sh of s.shields) {
        sh.y += sh.vy * dt;
      }
      for (const rf of s.rapidFires) {
        rf.y += rf.vy * dt;
      }
      for (const sb of s.smartBombs) {
        sb.y += sb.vy * dt;
      }
    }

    function applySnapshot(s: GameState, snap: NetSnapshot | null) {
      if (!snap) return;
      const scaleX = s.width / snap.width;
      const scaleY = s.height / snap.height;
      s.level = snap.level;
      s.levelDuration = snap.levelDuration;
      s.elapsed = snap.elapsed;
      const wantLocation = locationIndexForLevel(snap.level);
      if (s.locationTheme.index !== wantLocation) {
        s.locationTheme = getLocationTheme(wantLocation, s.width, s.height);
      }
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
          // Host-simulation-only detail for bullet-spawn timing, already
          // reflected visually in the bullets the ally receives (rapid flag).
          // The snapshot's own rapidFireUntil is read directly off `snap`
          // above (for the pickup-sound diff) before this object is built,
          // so this local copy staying 0 is harmless.
          rapidFireUntil: 0,
        };
      });
      s.enemies = snap.enemies.map((ne) => ({
        x: ne.x * scaleX,
        y: ne.y * scaleY,
        vy: ne.vy,
        phase: ne.phase,
        amp: ne.amp * scaleX,
        scale: ne.scale,
        fireTimer: 1,
        bombTimer: 1,
        orbit: ne.orbit
          ? {
              cx: ne.orbit.cx * scaleX,
              cy: ne.orbit.cy * scaleY,
              radius: ne.orbit.radius * scaleX,
              angle: ne.orbit.angle,
              speed: ne.orbit.speed,
            }
          : undefined,
      }));
      s.missiles = snap.missiles.map((nm) => ({
        x: nm.x * scaleX,
        y: nm.y * scaleY,
        vx: nm.vx,
        vy: nm.vy,
      }));
      s.bombs = snap.bombs.map((nb) => ({ x: nb.x * scaleX, y: nb.y * scaleY, vy: nb.vy, rot: nb.rot }));
      s.bullets = snap.bullets.map((nb) => ({
        x: nb.x * scaleX,
        y: nb.y * scaleY,
        vy: nb.vy,
        ownerId: "",
        rapid: nb.rapid,
      }));
      s.shields = snap.shields.map((ns) => ({ x: ns.x * scaleX, y: ns.y * scaleY, vy: ns.vy, phase: 0 }));
      s.rapidFires = snap.rapidFires.map((nr) => ({ x: nr.x * scaleX, y: nr.y * scaleY, vy: nr.vy, phase: 0 }));
      s.smartBombs = snap.smartBombs.map((nb) => ({ x: nb.x * scaleX, y: nb.y * scaleY, vy: nb.vy, phase: 0 }));

      const newScores = snap.players.map((np) => np.score);
      scoresRef.current = newScores;
      setScores((prev) =>
        prev.length === newScores.length && prev.every((v, i) => v === newScores[i]) ? prev : newScores
      );
      setScore((prev) => (prev !== snap.score ? snap.score : prev));
      setLives((prev) => (prev !== snap.lives ? snap.lives : prev));
      setShieldTotal((prev) => (prev !== snap.shieldTotal ? snap.shieldTotal : prev));
      if (snap.status !== statusRef.current) {
        statusRef.current = snap.status;
        setStatus(snap.status);
        if (snap.status === "playing") musicPlayerRef.current?.start(COOP_MUSIC_TRACK);
        else musicPlayerRef.current?.stop();
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
        shieldTotal: shieldTotalRef.current,
        players: s.players.map((pl, i) => ({
          id: pl.id,
          x: round1(pl.x),
          y: round1(pl.y),
          invuln: round1(pl.invuln),
          score: scoresRef.current[i] ?? 0,
          rapidFireUntil: round1(pl.rapidFireUntil),
        })),
        enemies: s.enemies
          .slice(0, MAX_SNAPSHOT_ENTITIES)
          .map((en) => ({
            x: round1(en.x),
            y: round1(en.y),
            vy: round1(en.vy),
            scale: round1(en.scale),
            phase: round1(en.phase),
            amp: round1(en.amp),
            orbit: en.orbit
              ? {
                  cx: round1(en.orbit.cx),
                  cy: round1(en.orbit.cy),
                  radius: round1(en.orbit.radius),
                  angle: round1(en.orbit.angle),
                  speed: round1(en.orbit.speed),
                }
              : undefined,
          })),
        missiles: s.missiles
          .slice(0, MAX_SNAPSHOT_ENTITIES)
          .map((m) => ({ x: round1(m.x), y: round1(m.y), vx: round1(m.vx), vy: round1(m.vy) })),
        bombs: s.bombs
          .slice(0, MAX_SNAPSHOT_ENTITIES)
          .map((b) => ({ x: round1(b.x), y: round1(b.y), vy: round1(b.vy), rot: round1(b.rot) })),
        bullets: s.bullets
          .slice(0, MAX_SNAPSHOT_ENTITIES)
          .map((b) => ({ x: round1(b.x), y: round1(b.y), vy: round1(b.vy), rapid: b.rapid })),
        shields: s.shields
          .slice(0, MAX_SNAPSHOT_ENTITIES)
          .map((sh) => ({ x: round1(sh.x), y: round1(sh.y), vy: round1(sh.vy) })),
        rapidFires: s.rapidFires
          .slice(0, MAX_SNAPSHOT_ENTITIES)
          .map((rf) => ({ x: round1(rf.x), y: round1(rf.y), vy: round1(rf.vy) })),
        smartBombs: s.smartBombs
          .slice(0, MAX_SNAPSHOT_ENTITIES)
          .map((sb) => ({ x: round1(sb.x), y: round1(sb.y), vy: round1(sb.vy) })),
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

      // stars
      for (const st of s.stars) {
        st.y += st.speed * dt;
        st.twinklePhase += dt * 3;
        if (st.y - st.r > s.height) {
          st.y = -st.r;
          st.x = Math.random() * s.width;
        }
      }

      // nebulae — same drift-and-wrap as stars, just much slower (they're
      // meant to read as far behind everything else).
      for (const nb of s.nebulae) {
        nb.y += nb.speed * dt;
        if (nb.y - nb.r > s.height) {
          nb.y = -nb.r;
          nb.x = Math.random() * s.width;
        }
      }

      // auto-fire, one volley per player — faster while a Rapid Fire buff
      // is active.
      for (const pl of s.players) {
        pl.fireTimer -= dt;
        if (pl.fireTimer <= 0) {
          const rapid = s.elapsed < pl.rapidFireUntil;
          pl.fireTimer = rapid ? RAPIDFIRE_INTERVAL : s.baseFireInterval;
          s.bullets.push({ x: pl.x - 7, y: pl.y - 14, vy: -560, ownerId: pl.id, rapid });
          s.bullets.push({ x: pl.x + 7, y: pl.y - 14, vy: -560, ownerId: pl.id, rapid });
        }
      }
      for (const b of s.bullets) b.y += b.vy * dt;
      s.bullets = s.bullets.filter((b) => b.y > -20);

      // Difficulty is driven by the level being played, stepped up +4% for
      // every full minute survived, and oscillates between a bomb-heavy
      // phase and a swarm-heavy phase as it climbs.
      const difficulty = levelDifficulty(s.level) * timeDifficultyMultiplier(s.elapsed);
      const { bombFocus, swarmFocus } = phaseFocus(s.elapsed);
      // Co-op ("ally") games get noticeably more enemy traffic than solo —
      // bursts arrive both bigger and more often, scaled off how many extra
      // teammates are in the fight.
      const extraPlayers = s.players.length - 1;
      // Last stretch of the clock: falling bursts keep arriving (rather than
      // stopping once the finale cluster lands) and come in bigger, faster,
      // and more often, so the closing seconds read as the hardest part of
      // the level instead of the finale cluster being the last word.
      const timeLeft = s.levelDuration - s.elapsed;
      const finalePush = timeLeft <= 8;
      s.spawnTimer -= dt;
      // Once the finale lineup has landed, the regular random bursts stop
      // (except during the finalePush window above) — it should read as a
      // clean shooting gallery, not get cluttered by more planes falling in
      // around it.
      if (s.spawnTimer <= 0 && (!s.finalWaveSpawned || finalePush)) {
        s.spawnTimer =
          (clamp(1.6 - difficulty * 0.5 - swarmFocus * 0.3, 0.45, 1.6) + Math.random() * 0.3) /
          (1 + extraPlayers * 0.35) /
          (finalePush ? 2.4 : 1);
        // Every burst is at least a pair so the wedge formation always reads
        // as a squadron arriving together — plus up to five extra enemies
        // per teammate beyond the first, scaled by the *shaped* swarm focus
        // (zero during the rest window around each phase crossing, ramping
        // to 5 at the true peak) so co-op gets a real breather between the
        // plane-heavy and bomb-heavy (see the bomb-timer bonus above)
        // stretches instead of constant elevated pressure. Also a
        // level-scaled bonus so deep runs get visibly bigger squadrons and
        // not just a spawn timer that's already hit its floor, plus a final
        // couple more once the last 8 seconds kick in.
        const extraSwarm = Math.min(1, Math.floor(swarmFocus * 2.2));
        const difficultySwarm = Math.floor(difficulty / 2.5);
        const coopPlaneBonus = Math.round(extraPlayers * coopBonusIntensity(swarmFocus) * 5);
        const count = 2 + coopPlaneBonus + extraSwarm + difficultySwarm + (finalePush ? 2 : 0);
        const spacing = 34;
        const offsets = wedgeFormation(count, spacing, 22);
        const maxAbsDx = Math.max(...offsets.map((o) => Math.abs(o.dx)));
        const margin = 30 + maxAbsDx;
        const anchorX = margin + Math.random() * Math.max(1, s.width - margin * 2);
        for (let i = 0; i < offsets.length; i++) {
          s.enemies.push({
            x: clamp(anchorX + offsets[i].dx, 30, s.width - 30),
            y: -30 + offsets[i].dy,
            vy: 55 + Math.random() * 35 + Math.min(difficulty, 14) * 40 + (finalePush ? 90 : 0),
            phase: Math.random() * Math.PI * 2,
            amp: 20 + Math.random() * 40,
            scale: 0.85 + Math.random() * 0.35,
            fireTimer: 1.8 + Math.random() * 1.8,
            bombTimer: 1.2 + Math.random() * 2.2,
          });
        }
      }

      // "An army of enemy planes" — once per level, at the halfway mark, a
      // dense grid formation arrives all at once instead of the usual small
      // wedge bursts. A warning banner (driven purely off elapsed/
      // levelDuration in render(), so it works identically for the ally too)
      // leads into it, and bombs are held off for a stretch afterward so the
      // player can focus on shooting the wave down instead of also dodging
      // bomb drops.
      if (!s.midpointWaveSpawned && s.elapsed >= s.levelDuration / 2) {
        s.midpointWaveSpawned = true;
        const rows = 3;
        const cols = 4 + extraPlayers * 2;
        const spacingX = 46;
        const offsets = gridFormation(rows, cols, spacingX, 42);
        const maxAbsDx = Math.max(...offsets.map((o) => Math.abs(o.dx)));
        const margin = 30 + maxAbsDx;
        const anchorX = clamp(s.width / 2, margin, Math.max(margin, s.width - margin));
        for (const offset of offsets) {
          s.enemies.push({
            x: clamp(anchorX + offset.dx, 30, s.width - 30),
            y: -30 + offset.dy,
            vy: 50 + Math.random() * 30 + Math.min(difficulty, 14) * 35,
            phase: Math.random() * Math.PI * 2,
            amp: 15 + Math.random() * 25,
            scale: 0.8 + Math.random() * 0.3,
            fireTimer: 1.8 + Math.random() * 1.8,
            bombTimer: 1.2 + Math.random() * 2.2,
          });
        }
        s.bombsSuppressedUntil = s.elapsed + 10;
      }

      // Finale: with 8 seconds left on the clock, a wide gathered band of
      // enemies arrives near the top of the screen and each one hovers
      // (a slow drifting loop, not a spin) around its own spot in the
      // formation instead of falling through and off the screen —
      // they stay put (and keep shooting) until the player clears them or
      // time runs out, rather than draining away and leaving nothing to
      // shoot at for the last few seconds. Any slot the player clears out
      // gets a fresh enemy after a short beat, so a fast player emptying the
      // whole cluster doesn't leave the sky empty for the rest of the window
      // — it keeps refilling until time actually runs out.
      const spawnFinalEnemy = (cx: number, cy: number) => {
        s.enemies.push({
          x: cx,
          y: cy,
          vy: 0,
          phase: Math.random() * Math.PI * 2,
          amp: 0,
          scale: 0.85 + Math.random() * 0.35,
          fireTimer: 1.8 + Math.random() * 1.8,
          bombTimer: 1.2 + Math.random() * 2.2,
          orbit: {
            cx,
            cy,
            // A slow, gentle drift -- reads as a cluster of planes hovering
            // in place (like clouds) rather than spinning -- that visibly
            // picks up urgency once finalePush kicks in.
            radius: 14 + Math.random() * 14,
            angle: Math.random() * Math.PI * 2,
            speed: (Math.random() < 0.5 ? -1 : 1) * (0.5 + Math.random() * 0.5) * (finalePush ? 1.8 : 1),
          },
        });
      };
      if (!s.finalWaveSpawned && timeLeft <= 8) {
        s.finalWaveSpawned = true;
        const rows = 2;
        const cols = 6 + extraPlayers * 2;
        const spacingX = 54;
        const spacingY = 42;
        const offsets = gridFormation(rows, cols, spacingX, spacingY);
        const maxAbsDx = Math.max(...offsets.map((o) => Math.abs(o.dx)));
        const margin = 30 + maxAbsDx;
        const anchorX = clamp(s.width / 2, margin, Math.max(margin, s.width - margin));
        const anchorY = s.height * 0.16;
        s.finalSlots = offsets.map((offset) => ({
          cx: clamp(anchorX + offset.dx, 30, s.width - 30),
          cy: anchorY + offset.dy,
        }));
        for (const slot of s.finalSlots) spawnFinalEnemy(slot.cx, slot.cy);
      } else if (s.finalWaveSpawned && timeLeft > 0) {
        s.finalRespawnTimer -= dt;
        if (s.finalRespawnTimer <= 0) {
          s.finalRespawnTimer = finalePush ? 0.3 + Math.random() * 0.3 : 0.8 + Math.random() * 0.8;
          const occupied = new Set(s.enemies.filter((en) => en.orbit).map((en) => `${en.orbit!.cx},${en.orbit!.cy}`));
          const emptySlots = s.finalSlots.filter((slot) => !occupied.has(`${slot.cx},${slot.cy}`));
          if (emptySlots.length > 0) {
            const slot = emptySlots[Math.floor(Math.random() * emptySlots.length)];
            spawnFinalEnemy(slot.cx, slot.cy);
          }
        }
      }

      for (const en of s.enemies) {
        if (en.orbit) {
          en.orbit.angle += en.orbit.speed * dt;
          en.x = clamp(en.orbit.cx + Math.cos(en.orbit.angle) * en.orbit.radius, 20, s.width - 20);
          en.y = en.orbit.cy + Math.sin(en.orbit.angle) * en.orbit.radius;
        } else {
          en.y += en.vy * dt;
          en.phase += dt * 1.6;
          en.x = clamp(en.x + Math.sin(en.phase) * en.amp * dt * 0.6, 20, s.width - 20);
        }
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
          // Co-op's extra pressure shouldn't only ever be "more planes" --
          // during a bomb-focus stretch of the phase cycle, extra teammates
          // also mean noticeably more bombs falling (shaped the same way as
          // the plane bonus above, so there's a real rest window between
          // the two rather than either always being at least partway on).
          en.bombTimer =
            clamp(2.8 - difficulty * 0.35 - bombFocus * 1.8 - extraPlayers * coopBonusIntensity(bombFocus) * 1.8, 0.3, 2.8) +
            Math.random() * 2.4;
          // Timer still resets on schedule during the post-wave suppression
          // window (so bombs don't all pile up and burst the moment it
          // ends) — only the actual drop is held back.
          if (s.elapsed >= s.bombsSuppressedUntil) {
            s.bombs.push({ x: en.x, y: en.y + 12, vy: 40, rot: Math.random() * Math.PI * 2 });
          }
        }
      }
      s.enemies = s.enemies.filter((en) => en.y < s.height + 40);

      // Shield drops on its own timer, independent of the enemy/bomb difficulty
      // ramp — it's a recovery mechanic, not a hazard, so it never gets
      // scarcer as the run gets harder. It does get more frequent the longer
      // the run goes, so recovery keeps pace with the growing pressure.
      s.shieldTimer -= dt;
      if (s.shieldTimer <= 0) {
        s.shieldTimer = (2 + Math.random() * 2.5) / shieldRateMultiplier(s.elapsed);
        s.shields.push({
          x: 24 + Math.random() * (s.width - 48),
          y: -20,
          vy: 55 + Math.random() * 20,
          phase: Math.random() * Math.PI * 2,
        });
      }
      for (const sh of s.shields) {
        sh.y += sh.vy * dt;
        sh.phase += dt * 2.2;
        sh.x = clamp(sh.x + Math.sin(sh.phase) * 16 * dt, 12, s.width - 12);
      }
      s.shields = s.shields.filter((sh) => sh.y < s.height + 30);

      // Rapid Fire and Smart Bomb: rarer than shields (fixed intervals, not
      // scaled by difficulty), since they're stronger, more situational
      // pickups rather than a steady recovery drip.
      s.rapidFireTimer -= dt;
      if (s.rapidFireTimer <= 0) {
        s.rapidFireTimer = 14 + Math.random() * 8;
        s.rapidFires.push({
          x: 24 + Math.random() * (s.width - 48),
          y: -20,
          vy: 55 + Math.random() * 20,
          phase: Math.random() * Math.PI * 2,
        });
      }
      for (const rf of s.rapidFires) {
        rf.y += rf.vy * dt;
        rf.phase += dt * 2.2;
        rf.x = clamp(rf.x + Math.sin(rf.phase) * 16 * dt, 12, s.width - 12);
      }
      s.rapidFires = s.rapidFires.filter((rf) => rf.y < s.height + 30);

      s.smartBombTimer -= dt;
      if (s.smartBombTimer <= 0) {
        s.smartBombTimer = 26 + Math.random() * 12;
        s.smartBombs.push({
          x: 24 + Math.random() * (s.width - 48),
          y: -20,
          vy: 50 + Math.random() * 18,
          phase: Math.random() * Math.PI * 2,
        });
      }
      for (const sb of s.smartBombs) {
        sb.y += sb.vy * dt;
        sb.phase += dt * 2.2;
        sb.x = clamp(sb.x + Math.sin(sb.phase) * 16 * dt, 12, s.width - 12);
      }
      s.smartBombs = s.smartBombs.filter((sb) => sb.y < s.height + 30);

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
      if (deadEnemies.size) {
        s.enemies = s.enemies.filter((en) => !deadEnemies.has(en));
        playEnemyHitSound();
      }
      if (deadBullets.size) s.bullets = s.bullets.filter((b) => !deadBullets.has(b));
      if (scored) {
        setScores([...scoresRef.current]);
        scoreRef.current = scoresRef.current.reduce((sum, v) => sum + (v ?? 0), 0);
        setScore(scoreRef.current);
      }

      // shield pickups — any plane flying through one collects it into the
      // shared team total; every full SHIELD_PER_LIFE collected restores one
      // life back into the shared pool (never past maxLives).
      const collectedShields = new Set<Shield>();
      for (const sh of s.shields) {
        for (const pl of s.players) {
          const r = PLAYER_HIT_RADIUS + SHIELD_HIT_RADIUS;
          if (dist2(pl.x, pl.y, sh.x, sh.y) < r * r) {
            collectedShields.add(sh);
            break;
          }
        }
      }
      if (collectedShields.size) {
        s.shields = s.shields.filter((sh) => !collectedShields.has(sh));
        for (const sh of collectedShields) {
          spawnExplosion(s.particles, sh.x, sh.y, ["#ffd75e", "#fff3c0", "#c98a1f"], 10);
        }
        playShieldPickupSound();
        const prevTotal = shieldTotalRef.current;
        const newTotal = prevTotal + collectedShields.size * SHIELD_VALUE;
        shieldTotalRef.current = newTotal;
        setShieldTotal(newTotal);
        const livesToRestore = Math.floor(newTotal / SHIELD_PER_LIFE) - Math.floor(prevTotal / SHIELD_PER_LIFE);
        if (livesToRestore > 0) {
          setLives((lv) => Math.min(maxLivesRef.current, lv + livesToRestore));
          const healInvuln = healInvulnDuration(newTotal);
          for (const pl of s.players) {
            pl.invuln = Math.max(pl.invuln, healInvuln);
          }
        }
      }

      // rapid fire pickups — a personal buff for whichever plane grabs it,
      // not a shared team resource like shields.
      for (const pl of s.players) {
        for (const rf of s.rapidFires) {
          const r = PLAYER_HIT_RADIUS + RAPIDFIRE_HIT_RADIUS;
          if (dist2(pl.x, pl.y, rf.x, rf.y) < r * r) {
            pl.rapidFireUntil = Math.max(pl.rapidFireUntil, s.elapsed) + RAPIDFIRE_DURATION;
            spawnExplosion(s.particles, rf.x, rf.y, ["#fff3b0", "#ffb833", "#c9660a"], 10);
            playRapidFireSound();
            s.rapidFires = s.rapidFires.filter((r2) => r2 !== rf);
            break;
          }
        }
      }

      // smart bomb pickups — instantly clears every enemy currently on
      // screen, credited to whoever grabbed it like a bullet kill would be.
      for (const pl of s.players) {
        for (const sb of s.smartBombs) {
          const r = PLAYER_HIT_RADIUS + SMARTBOMB_HIT_RADIUS;
          if (dist2(pl.x, pl.y, sb.x, sb.y) < r * r) {
            spawnExplosion(s.particles, sb.x, sb.y, ["#ffc9b0", "#ff5a3c", "#8a0f0f"], 14);
            playSmartBombPickupSound();
            const idx = s.players.findIndex((p) => p.id === pl.id);
            if (s.enemies.length > 0) {
              for (const en of s.enemies) {
                spawnExplosion(s.particles, en.x, en.y, ["#ffcf5c", "#ff7a3c", "#8a8f96"]);
                if (idx >= 0) scoresRef.current[idx] = (scoresRef.current[idx] ?? 0) + 10;
              }
              s.enemies = [];
              setScores([...scoresRef.current]);
              scoreRef.current = scoresRef.current.reduce((sum, v) => sum + (v ?? 0), 0);
              setScore(scoreRef.current);
              playEnemyHitSound();
            }
            s.smartBombs = s.smartBombs.filter((s2) => s2 !== sb);
            break;
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
              musicPlayerRef.current?.stop();
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
                    body: JSON.stringify({ score: nb, level: s.level }),
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
        musicPlayerRef.current?.stop();
        const nextLevel = s.level + 1;
        const crossedLocation = locationIndexForLevel(nextLevel) > locationIndexForLevel(s.level);
        setJustUnlockedLocation(crossedLocation ? getLocationName(locationIndexForLevel(nextLevel)) : null);
        setSoloStartLevel(nextLevel);
        setUnlockedLevel((u) => {
          if (nextLevel <= u) return u;
          try {
            window.localStorage.setItem(UNLOCKED_LEVEL_KEY, String(nextLevel));
          } catch {
            // ignore
          }
          return nextLevel;
        });
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
              body: JSON.stringify({ score: nb, level: s.level }),
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
      const theme = s.locationTheme;
      const sky = c.createLinearGradient(0, 0, 0, height);
      sky.addColorStop(0, theme.palette.sky[0]);
      sky.addColorStop(0.45, theme.palette.sky[1]);
      sky.addColorStop(0.8, theme.palette.sky[2]);
      sky.addColorStop(1, theme.palette.sky[3]);
      c.fillStyle = sky;
      c.fillRect(0, 0, width, height);

      for (const nb of s.nebulae) {
        const glow = c.createRadialGradient(nb.x, nb.y, 0, nb.x, nb.y, nb.r);
        glow.addColorStop(0, `rgba(${nb.color},0.12)`);
        glow.addColorStop(1, `rgba(${nb.color},0)`);
        c.fillStyle = glow;
        c.beginPath();
        c.arc(nb.x, nb.y, nb.r, 0, Math.PI * 2);
        c.fill();
      }

      c.save();
      for (const st of s.stars) {
        const twinkle = 0.7 + 0.3 * Math.sin(st.twinklePhase);
        drawStar(c, st.x, st.y, st.r, st.opacity * twinkle);
      }
      c.restore();

      // Distant horizon silhouette — a smooth skyline (precomputed once per
      // location, not regenerated per frame) rather than a jagged random
      // shape, with a soft rim-light along the ridge for atmosphere.
      const horizon = theme.horizon;
      if (horizon.length > 1) {
        c.save();
        c.beginPath();
        c.moveTo(horizon[0].x, height);
        for (const pt of horizon) c.lineTo(pt.x, pt.y);
        c.lineTo(horizon[horizon.length - 1].x, height);
        c.closePath();
        const silGrad = c.createLinearGradient(0, horizon[0].y - 20, 0, height);
        silGrad.addColorStop(0, "#000000cc");
        silGrad.addColorStop(1, "#000000ee");
        c.fillStyle = silGrad;
        c.fill();

        c.beginPath();
        c.moveTo(horizon[0].x, horizon[0].y);
        for (const pt of horizon) c.lineTo(pt.x, pt.y);
        c.strokeStyle = `${theme.palette.planetEdge}99`;
        c.lineWidth = 1.5;
        c.stroke();
        c.restore();
      }

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

      // shield pickups
      for (const sh of s.shields) {
        c.save();
        c.translate(sh.x, sh.y);
        drawShield(c, Math.sin(sh.phase));
        c.restore();
      }

      // rapid fire pickups
      for (const rf of s.rapidFires) {
        c.save();
        c.translate(rf.x, rf.y);
        drawRapidFire(c, Math.sin(rf.phase));
        c.restore();
      }

      // smart bomb pickups
      for (const sb of s.smartBombs) {
        c.save();
        c.translate(sb.x, sb.y);
        drawSmartBomb(c, Math.sin(sb.phase));
        c.restore();
      }

      // bullets
      for (const b of s.bullets) {
        c.save();
        c.translate(b.x, b.y);
        drawBullet(c, b.rapid);
        c.restore();
      }

      // enemies — no bank tilt: they're in continuous sine-wave sway (or
      // orbit), not discrete steering like the player, so a velocity-
      // derived bank angle was always nonzero and read as a constant wobble
      // rather than an occasional lean into a turn.
      for (const en of s.enemies) {
        c.save();
        c.translate(en.x, en.y);
        drawJetShadow(c, en.scale);
        c.rotate(Math.PI);
        if (!USE_PLANE_SPRITES || !drawJetSprite(c, jetImagesRef.current.red, en.scale)) {
          drawJet(c, en.scale, Math.abs(Math.sin(s.elapsed * 18 + en.phase)), ENEMY_SCHEME);
        }
        c.restore();
      }

      // players — bank eased from this client's own frame-to-frame x delta
      // for whichever plane it's rendering (own, host's, or ally's), purely
      // a local visual touch that isn't networked or gameplay-affecting.
      if (currentStatus !== "gameover") {
        s.players.forEach((pl, i) => {
          const flashHidden = pl.invuln > 0 && Math.floor(pl.invuln * 10) % 2 === 0;
          if (flashHidden) return;
          const prevX = playerLastXRef.current.get(pl.id) ?? pl.x;
          const targetBank = clamp((pl.x - prevX) * 0.07, -0.5, 0.5);
          playerLastXRef.current.set(pl.id, pl.x);
          const prevBank = playerBankRef.current.get(pl.id) ?? 0;
          const bank = prevBank + (targetBank - prevBank) * 0.3;
          playerBankRef.current.set(pl.id, bank);
          c.save();
          c.translate(pl.x, pl.y);
          drawJetShadow(c, 1);
          c.rotate(bank);
          const spriteKey = PLAYER_SPRITE_KEYS[i % PLAYER_SPRITE_KEYS.length];
          if (!USE_PLANE_SPRITES || !drawJetSprite(c, jetImagesRef.current[spriteKey], 1)) {
            drawJet(c, 1, Math.abs(Math.sin(s.elapsed * 22)), PLAYER_SCHEMES[i % PLAYER_SCHEMES.length]);
          }
          c.restore();
        });
      }

      // chat bubbles — one per player, drawn above their plane, self-expiring
      // (deleted the moment they're stale rather than tracked elsewhere).
      if (chatBubblesRef.current.size > 0) {
        const now = performance.now();
        for (const pl of s.players) {
          const bubble = chatBubblesRef.current.get(pl.id);
          if (!bubble) continue;
          if (bubble.until <= now) {
            chatBubblesRef.current.delete(pl.id);
            continue;
          }
          const fadeIn = clamp((CHAT_BUBBLE_DURATION - (bubble.until - now)) / 150, 0, 1);
          const fadeOut = clamp((bubble.until - now) / 300, 0, 1);
          c.save();
          c.globalAlpha = Math.min(fadeIn, fadeOut);
          c.font = "600 12px sans-serif";
          const textWidth = c.measureText(bubble.text).width;
          const padX = 8;
          const bw = textWidth + padX * 2;
          const bh = 22;
          const bx = clamp(pl.x - bw / 2, 4, s.width - bw - 4);
          const by = pl.y - PLAYER_RADIUS - bh - 12;
          c.fillStyle = "rgba(10,12,24,0.85)";
          c.strokeStyle = "rgba(255,255,255,0.35)";
          c.lineWidth = 1;
          const r = 8;
          c.beginPath();
          c.moveTo(bx + r, by);
          c.arcTo(bx + bw, by, bx + bw, by + bh, r);
          c.arcTo(bx + bw, by + bh, bx, by + bh, r);
          c.arcTo(bx, by + bh, bx, by, r);
          c.arcTo(bx, by, bx + bw, by, r);
          c.closePath();
          c.fill();
          c.stroke();
          c.fillStyle = "#fff";
          c.textAlign = "center";
          c.textBaseline = "middle";
          c.fillText(bubble.text, bx + bw / 2, by + bh / 2 + 1);
          c.restore();
        }
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

    // Runs once inside this mount effect to seed the game clock, never during render.
    // eslint-disable-next-line react-hooks/purity
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
  // True for a real single-player run (not co-op) — the only mode where
  // surviving actually advances soloStartLevel, so "Play Again" should read
  // as forward progress rather than a replay.
  const isProgressiveRun = netRole === "solo" && lobbyMode === "solo";

  // Locations roadmap: a winding route of location nodes climbing from the
  // start toward the frontier, plus a handful of upcoming locked ones so
  // players can see what's coming without spoiling the whole endless ladder.
  // Capped to the last 24 unlocked so an extremely deep run doesn't render an
  // unbounded path.
  const UPCOMING_PREVIEW_COUNT = 5;
  const frontierLocation = locationIndexForLevel(unlockedLevel);
  const roadmapStart = Math.max(1, frontierLocation - 23);
  const roadmapIndices: number[] = [];
  for (let i = roadmapStart; i <= frontierLocation + UPCOMING_PREVIEW_COUNT; i++) roadmapIndices.push(i);
  const roadmapCount = roadmapIndices.length;
  const roadmapHeight = PATH_TOP_PAD + PATH_BOTTOM_PAD + Math.max(0, roadmapCount - 1) * PATH_NODE_SPACING;
  const roadmapNodeCenter = (k: number) => ({
    x: pathNodeX(k),
    y: PATH_TOP_PAD + (roadmapCount - 1 - k) * PATH_NODE_SPACING,
  });
  const roadmapPathD = catmullRomPath(
    Array.from({ length: roadmapCount }, (_, k) => roadmapNodeCenter(k))
  );
  const roadmapPaletteAt = (k: number) => LOCATION_PALETTES[roadmapIndices[k] % LOCATION_PALETTES.length];
  // Whether location #1 — and so the very start of the endless route — is
  // currently in the visible (windowed) portion of the roadmap.
  const roadmapShowsStart = roadmapIndices[0] === 1;

  // Auto-scroll the roadmap so the relevant node is in view the moment the
  // screen opens, instead of dropping the player at the very bottom (the
  // start of an endless route) every time. Defaults to the frontier, but
  // prefers a just-unlocked location when opened from that reveal moment.
  useEffect(() => {
    if (!showLocations) return;
    const el = locationsScrollRef.current;
    if (!el) return;
    const targetIdx = highlightLocation ?? frontierLocation;
    const seq = roadmapIndices.indexOf(targetIdx);
    if (seq < 0) return;
    const target = roadmapNodeCenter(seq).y;
    requestAnimationFrame(() => {
      el.scrollTop = Math.max(0, target - el.clientHeight / 2);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showLocations]);

  const roadmapStars = useMemo(() => {
    const rand = mulberry32(4242);
    return Array.from({ length: 80 }, () => ({
      x: rand() * 100,
      y: rand() * 100,
      r: 0.6 + rand() * 1.6,
      o: 0.15 + rand() * 0.5,
    }));
  }, []);

  return (
    <div
      ref={containerRef}
      className="relative h-dvh w-full overflow-hidden select-none bg-[#0c1230]"
    >
      <canvas ref={canvasRef} className="absolute inset-0 block" />

      <div className="pointer-events-none absolute inset-x-0 top-0 z-30 flex items-start justify-between p-3 sm:p-4 text-white font-sans">
        {status !== "ready" &&
          (netRole === "solo" ? (
            <div className="rounded-lg bg-black/35 px-3 py-1.5 backdrop-blur-sm">
              <div className="text-xs uppercase tracking-wide text-white/60">Score</div>
              <div className="text-lg font-bold tabular-nums leading-tight">{score}</div>
              {lobbyMode === "solo" && (
                <div className="max-w-[8rem] truncate text-[10px] text-white/50">
                  📍 {getLocationName(locationIndexForLevel(soloStartLevel))} · Lv {soloStartLevel}
                </div>
              )}
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
          ))}
        {status !== "ready" && (
          <div className="rounded-lg bg-black/35 px-3 py-1.5 backdrop-blur-sm text-center">
            <div className="text-xs uppercase tracking-wide text-white/60">Best Score</div>
            <div className="text-lg font-bold tabular-nums leading-tight">{best}</div>
          </div>
        )}
        {status !== "ready" && (
          <div className="rounded-lg bg-black/35 px-3 py-1.5 backdrop-blur-sm text-center">
            <div className="text-xs uppercase tracking-wide text-white/60">Time</div>
            <div ref={timerValueRef} className="text-lg font-bold tabular-nums leading-tight">
              0:00
            </div>
          </div>
        )}
        <div className="flex items-start gap-1.5">
          {status !== "ready" && (
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
          )}
          {status === "ready" && lobbyMode === "solo" && (
            <button
              onClick={() => setShowLocations(true)}
              aria-label="Locations"
              className="pointer-events-auto rounded-lg bg-black/35 px-2.5 py-1.5 text-lg leading-none backdrop-blur-sm active:scale-95 transition-transform"
            >
              🗺️
            </button>
          )}
          {netRole !== "solo" && status === "playing" && (
            <button
              onClick={() => setShowChat((v) => !v)}
              aria-label={showChat ? "Close chat" : "Open chat"}
              className="pointer-events-auto rounded-lg bg-black/35 px-2.5 py-1.5 text-lg leading-none backdrop-blur-sm active:scale-95 transition-transform"
            >
              💬
            </button>
          )}
          <button
            onClick={() => setMusicMuted((m) => !m)}
            aria-label={musicMuted ? "Unmute music" : "Mute music"}
            className="pointer-events-auto rounded-lg bg-black/35 px-2.5 py-1.5 text-lg leading-none backdrop-blur-sm active:scale-95 transition-transform"
          >
            {musicMuted ? "🔇" : "🔊"}
          </button>
        </div>
      </div>

      {showChat && netRole !== "solo" && status === "playing" && (
        <div className="absolute right-3 top-16 z-40 w-64 rounded-xl bg-black/85 p-3 text-white backdrop-blur-sm font-sans sm:right-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase tracking-wide text-white/50">Quick Chat</span>
            <button
              onClick={() => setShowChat(false)}
              aria-label="Close chat"
              className="rounded-full bg-white/10 px-2 py-0.5 text-xs font-bold active:scale-95 transition-transform"
            >
              ✕
            </button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {CHAT_PRESETS.map((msg) => (
              <button
                key={msg}
                onClick={() => sendChat(msg)}
                className="rounded-full bg-white/10 px-3 py-1.5 text-xs font-semibold active:scale-95 transition-transform"
              >
                {msg}
              </button>
            ))}
          </div>
          <div className="mt-2 flex gap-1.5">
            <input
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") sendChat(chatInput);
              }}
              maxLength={40}
              placeholder="Type…"
              className="min-w-0 flex-1 rounded-lg bg-white/90 px-2.5 py-1.5 text-xs text-black"
            />
            <button
              onClick={() => sendChat(chatInput)}
              className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-bold active:scale-95 transition-transform"
            >
              Send
            </button>
          </div>
        </div>
      )}

      {showLocations && (
        <div className="absolute inset-0 z-20 flex flex-col bg-[#05060c] text-white font-sans">
          <div className="flex items-center justify-between px-5 pt-20 pb-2">
            <div>
              <h2 className="text-xl font-extrabold tracking-tight">Locations</h2>
              <p className="text-[11px] text-white/50">
                {highlightLocation
                  ? "This is your new stop on the route."
                  : "Survive a level to unlock the next stop on the route."}
              </p>
            </div>
            <button
              onClick={() => {
                setShowLocations(false);
                setHighlightLocation(null);
                if (statusRef.current === "ready") {
                  musicPlayerRef.current?.start(MENU_MUSIC_TRACK);
                }
              }}
              aria-label="Close"
              className="rounded-full bg-white/10 px-3 py-1.5 text-sm font-semibold active:scale-95 transition-transform"
            >
              ✕
            </button>
          </div>

          <div ref={locationsScrollRef} className="relative flex-1 overflow-y-auto overflow-x-hidden">
            <div
              className="pointer-events-none absolute inset-0"
              style={{
                background:
                  "radial-gradient(circle at 25% 20%, rgba(120,90,200,0.16), transparent 55%), radial-gradient(circle at 75% 60%, rgba(80,150,220,0.14), transparent 55%)",
              }}
            />
            <div className="relative mx-auto" style={{ width: PATH_WIDTH, height: roadmapHeight }}>
              {/* Purely decorative distant scenery -- a soft nebula cluster
                  and a couple of planets/moons scattered along the route,
                  not tied to any location node. */}
              <div
                className="pointer-events-none absolute rounded-full"
                style={{
                  left: "10%",
                  top: 50,
                  width: 160,
                  height: 160,
                  background:
                    "radial-gradient(circle, rgba(210,180,255,0.45), rgba(140,100,220,0.2) 45%, transparent 70%)",
                  filter: "blur(3px)",
                }}
              />
              <div
                className="pointer-events-none absolute rounded-full"
                style={{
                  right: "4%",
                  top: 24,
                  width: 84,
                  height: 84,
                  background: "radial-gradient(circle at 35% 30%, #ded4ff, #6a5aa8 60%, #000 100%)",
                  boxShadow: "0 0 28px 10px rgba(120,100,200,0.3)",
                }}
              />
              <div
                className="pointer-events-none absolute rounded-full"
                style={{
                  right: "-10%",
                  bottom: 10,
                  width: 220,
                  height: 220,
                  background: "radial-gradient(circle at 30% 30%, #ffe9d6, #b5763f 55%, #3a2210 100%)",
                  boxShadow: "0 0 40px 12px rgba(180,120,60,0.25)",
                }}
              />

              {/* Each location tints the backdrop near its own node with its
                  own palette, so the scenery's mood shifts as you scroll
                  through the route instead of staying one flat color. */}
              {roadmapIndices.map((idx, k) => {
                const { x, y } = roadmapNodeCenter(k);
                const palette = LOCATION_PALETTES[idx % LOCATION_PALETTES.length];
                return (
                  <div
                    key={`halo-${idx}`}
                    className="pointer-events-none absolute"
                    style={{
                      left: x,
                      top: y,
                      width: 440,
                      height: 440,
                      transform: "translate(-50%, -50%)",
                      background: `radial-gradient(circle, rgba(${palette.nebulaTint},0.24), rgba(${palette.nebulaTint},0.06) 55%, transparent 75%)`,
                    }}
                  />
                );
              })}

              {roadmapStars.map((s, i) => (
                <span
                  key={i}
                  className="absolute rounded-full bg-white"
                  style={{ left: `${s.x}%`, top: `${s.y}%`, width: s.r, height: s.r, opacity: s.o }}
                />
              ))}

              {roadmapShowsStart && (
                <div
                  className="absolute text-center text-[9px] font-bold uppercase tracking-[0.2em] text-white/40"
                  style={{ left: roadmapNodeCenter(0).x, top: roadmapHeight - 30, transform: "translateX(-50%)" }}
                >
                  Start
                </div>
              )}
              <div
                className="absolute w-full text-center text-[10px] italic text-white/35"
                style={{ top: 18 }}
              >
                the journey continues…
              </div>

              <svg width={PATH_WIDTH} height={roadmapHeight} className="absolute inset-0">
                <defs>
                  <linearGradient
                    id="roadmapPathGrad"
                    gradientUnits="userSpaceOnUse"
                    x1={PATH_WIDTH / 2}
                    y1={0}
                    x2={PATH_WIDTH / 2}
                    y2={roadmapHeight}
                  >
                    <stop offset="0%" stopColor={roadmapPaletteAt(roadmapCount - 1).planetEdge} />
                    <stop offset="50%" stopColor={roadmapPaletteAt(Math.floor(roadmapCount / 2)).planetEdge} />
                    <stop offset="100%" stopColor={roadmapPaletteAt(0).planetEdge} />
                  </linearGradient>
                </defs>
                <path d={roadmapPathD} fill="none" stroke="url(#roadmapPathGrad)" strokeOpacity={0.35} strokeWidth={10} strokeLinecap="round" />
                <path
                  d={roadmapPathD}
                  fill="none"
                  stroke="rgba(255,255,255,0.45)"
                  strokeWidth={2.5}
                  strokeLinecap="round"
                  strokeDasharray="1 11"
                />
              </svg>

              {roadmapIndices.map((idx, k) => {
                const { x, y } = roadmapNodeCenter(k);
                const locked = idx > frontierLocation;
                const palette = LOCATION_PALETTES[idx % LOCATION_PALETTES.length];
                const startLevel = idx;
                const isFrontier = idx === frontierLocation;
                const isSelected = idx === locationIndexForLevel(soloStartLevel);
                const isHighlighted = highlightLocation === idx;
                const badges = perkSummary(idx);
                return (
                  <div key={idx} className="contents">
                    {isHighlighted && (
                      <span
                        className="pointer-events-none absolute animate-ping rounded-full"
                        style={{
                          left: x,
                          top: y,
                          width: PATH_NODE_R * 2 + 20,
                          height: PATH_NODE_R * 2 + 20,
                          transform: "translate(-50%, -50%)",
                          background: `${palette.planetEdge}66`,
                        }}
                      />
                    )}
                    <button
                      disabled={locked}
                      onClick={() => {
                        setTappedLocation(idx);
                        playPageFlipSound();
                        setTimeout(() => {
                          setShowLocations(false);
                          setHighlightLocation(null);
                          setTappedLocation(null);
                          startSolo(startLevel);
                        }, 220);
                      }}
                      aria-label={locked ? `${getLocationName(idx)} (locked)` : `Start at ${getLocationName(idx)}`}
                      className={`absolute flex items-center justify-center rounded-full transition-transform duration-200 ${
                        locked ? "opacity-50 grayscale" : "active:scale-95"
                      }`}
                      style={{
                        left: x,
                        top: y,
                        width: PATH_NODE_R * 2,
                        height: PATH_NODE_R * 2,
                        transform:
                          tappedLocation === idx ? "translate(-50%, -50%) scale(1.18)" : "translate(-50%, -50%)",
                        boxShadow:
                          tappedLocation === idx
                            ? `0 0 0 4px rgba(255,255,255,0.95), 0 0 42px 16px rgba(255,255,255,0.9)`
                            : isHighlighted
                              ? `0 0 0 3px rgba(250,204,21,0.95), 0 0 26px 8px rgba(250,204,21,0.6)`
                              : isFrontier
                                ? `0 0 0 3px rgba(52,211,153,0.95), 0 0 26px 9px rgba(52,211,153,0.65)`
                                : isSelected
                                  ? `0 0 0 3px rgba(96,165,250,0.9), 0 0 14px 3px ${palette.planetEdge}88`
                                  : `0 0 14px 3px ${palette.planetEdge}66`,
                      }}
                    >
                      {/* Hexagon badge body — clipped separately from the
                          button itself so the soft outer glow above isn't
                          also clipped to the hex outline. */}
                      <span
                        className="absolute inset-0"
                        style={{
                          clipPath: "polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)",
                          background: `linear-gradient(150deg, ${palette.planetCore}, ${palette.planetEdge} 65%, #000 130%)`,
                        }}
                      />
                      {isFrontier && !locked && !isHighlighted && (
                        <span
                          className="absolute inset-0 animate-pulse"
                          style={{
                            clipPath: "polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)",
                            boxShadow: "inset 0 0 0 3px rgba(52,211,153,0.9)",
                          }}
                        />
                      )}
                      {locked && <span className="relative text-base">🔒</span>}
                      <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-black/70 px-1 text-[10px] font-bold text-white ring-1 ring-white/30">
                        {idx}
                      </span>
                      {isHighlighted ? (
                        <span className="absolute -bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-yellow-400 px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wide text-black">
                          New!
                        </span>
                      ) : (
                        isFrontier &&
                        !locked && (
                          <span className="absolute -bottom-3 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-emerald-500 px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wide">
                            You are here
                          </span>
                        )
                      )}
                    </button>

                    <div
                      className="absolute w-36 text-center"
                      style={{ left: x, top: y + PATH_NODE_R + 10, transform: "translateX(-50%)" }}
                    >
                      <div className="truncate text-xs font-bold">{getLocationName(idx)}</div>
                      <div className="text-[10px] text-white/60">
                        {locked ? `Reach Level ${startLevel}` : `Level ${startLevel}`}
                      </div>
                      {badges.length > 0 && (
                        <div className="mt-1 flex flex-wrap justify-center gap-1">
                          {badges.map((b) => (
                            <span key={b} className="rounded-full bg-black/40 px-1.5 py-0.5 text-[8px] text-white/80">
                              {b}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {status === "ready" && !showLocations && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 overflow-y-auto bg-gradient-to-b from-black/25 via-black/45 to-black/75 px-6 py-8 text-center text-white font-sans">
          <img
            src="/brand/sky-raider-logo.webp"
            alt="Sky Raider"
            className="-mx-6 w-[calc(100%+3rem)] drop-shadow-[0_4px_24px_rgba(56,132,255,0.4)]"
          />

          {showSoundPrompt && (
            <button
              onClick={() => {
                setShowSoundPrompt(false);
                musicPlayerRef.current?.start(MENU_MUSIC_TRACK);
              }}
              className="-mt-2 flex items-center gap-1.5 rounded-full border border-white/25 bg-black/40 px-4 py-1.5 text-xs font-semibold text-white/90 backdrop-blur-sm active:scale-95 transition-transform animate-pulse"
            >
              🔊 Tap for Sound
            </button>
          )}

          <div className="grid w-full max-w-xs grid-cols-3 gap-2.5">
            {(
              [
                { m: "solo", label: "Single Player", icon: "🎮", accent: "blue" },
                { m: "host", label: "Get Ally", icon: "🤝", accent: "amber" },
                { m: "join", label: "Join Ally", icon: "🔗", accent: "violet" },
              ] as { m: LobbyMode; label: string; icon: string; accent: "blue" | "amber" | "violet" }[]
            ).map(({ m, label, icon, accent }) => {
              const active = lobbyMode === m;
              const accentClasses: Record<"blue" | "amber" | "violet", string> = {
                blue: active
                  ? "border-blue-400 bg-gradient-to-b from-blue-500 to-blue-800 shadow-[0_0_18px_2px_rgba(59,130,246,0.55),inset_0_1px_0_rgba(255,255,255,0.35),inset_0_-8px_12px_rgba(0,0,0,0.35),0_8px_12px_-4px_rgba(0,0,0,0.6)] text-white"
                  : "border-blue-400/30 bg-gradient-to-b from-white/10 to-white/0 text-white/70 shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_4px_8px_-4px_rgba(0,0,0,0.55)] hover:border-blue-400/60",
                amber: active
                  ? "border-amber-400 bg-gradient-to-b from-amber-400 to-amber-800 shadow-[0_0_18px_2px_rgba(245,158,11,0.55),inset_0_1px_0_rgba(255,255,255,0.35),inset_0_-8px_12px_rgba(0,0,0,0.35),0_8px_12px_-4px_rgba(0,0,0,0.6)] text-white"
                  : "border-amber-400/30 bg-gradient-to-b from-white/10 to-white/0 text-white/70 shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_4px_8px_-4px_rgba(0,0,0,0.55)] hover:border-amber-400/60",
                violet: active
                  ? "border-violet-400 bg-gradient-to-b from-violet-500 to-violet-800 shadow-[0_0_18px_2px_rgba(139,92,246,0.55),inset_0_1px_0_rgba(255,255,255,0.35),inset_0_-8px_12px_rgba(0,0,0,0.35),0_8px_12px_-4px_rgba(0,0,0,0.6)] text-white"
                  : "border-violet-400/30 bg-gradient-to-b from-white/10 to-white/0 text-white/70 shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_4px_8px_-4px_rgba(0,0,0,0.55)] hover:border-violet-400/60",
              };
              return (
                <button
                  key={m}
                  onClick={() => selectLobbyMode(m)}
                  className={`flex flex-col items-center gap-1.5 rounded-2xl border-2 px-3 py-3.5 text-sm font-bold transition-all active:scale-95 active:translate-y-0.5 ${accentClasses[accent]}`}
                >
                  <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-black/25 text-xl leading-none shadow-[inset_0_1px_0_rgba(255,255,255,0.3),inset_0_-2px_4px_rgba(0,0,0,0.45)]">
                    {icon}
                  </span>
                  {label}
                </button>
              );
            })}
          </div>

          {lobbyMode === "host" && (
            <div className="flex flex-col items-center gap-1.5 rounded-xl bg-white/10 px-4 py-3">
              {connStatus === "idle" && (
                <div className="relative">
                  <span className="pointer-events-none absolute -inset-2 rounded-full bg-amber-400/30 blur-lg" />
                  <button
                    onClick={hostRoom}
                    className="relative rounded-full border-2 border-amber-300/80 bg-gradient-to-b from-amber-300 via-amber-500 to-amber-700 px-8 py-2.5 text-base font-extrabold tracking-wide text-amber-950 shadow-[inset_0_2px_0_rgba(255,255,255,0.5),inset_0_-5px_8px_rgba(120,53,15,0.35),0_3px_0_0_rgba(120,53,15,0.9),0_8px_18px_-4px_rgba(245,158,11,0.6)] transition-all active:translate-y-0.5 active:shadow-[0_1px_0_0_rgba(120,53,15,0.9)]"
                  >
                    🤝 Invite Ally
                  </button>
                </div>
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
              <p className="max-w-[16rem] text-center text-xl font-bold text-violet-300 font-[family-name:var(--font-game)]">
                Enter the 3-digit code to join game!
              </p>
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

          {best > 0 && <p className="text-xs text-white/60">Your Best Score: {best}</p>}

          <AuthPanel
            ref={authPanelRef}
            onUserChange={handleUserChange}
            refreshLeaderboardKey={refreshLeaderboardKey}
            onTopChange={setGlobalTop}
            onPendingAuthChange={setAuthPending}
          />

          {(lobbyMode === "solo" || (lobbyMode === "host" && connStatus === "connected")) && (
            <div className="relative mt-1">
              <span className="pointer-events-none absolute -inset-3 rounded-full bg-amber-400/30 blur-xl" />
              <button
                onClick={handleStart}
                disabled={authPending}
                className="relative rounded-full border-2 border-amber-300/80 bg-gradient-to-b from-amber-300 via-amber-500 to-amber-700 px-10 py-3 text-lg font-extrabold tracking-wide text-amber-950 shadow-[inset_0_2px_0_rgba(255,255,255,0.5),inset_0_-6px_10px_rgba(120,53,15,0.35),0_4px_0_0_rgba(120,53,15,0.9),0_10px_24px_-4px_rgba(245,158,11,0.6)] transition-all active:translate-y-0.5 active:shadow-[0_1px_0_0_rgba(120,53,15,0.9)] disabled:opacity-40 disabled:active:translate-y-0"
              >
                🛩️ Start
              </button>
            </div>
          )}
          {user && (
            <button
              onClick={() => authPanelRef.current?.logout()}
              className="rounded-full border border-white/20 bg-white/10 px-5 py-1.5 text-xs font-semibold active:scale-95 transition-transform"
            >
              Logout
            </button>
          )}
        </div>
      )}

      {status === "levelcomplete" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black/65 px-6 text-center text-white font-sans">
          <h2
            className="bg-gradient-to-b from-white via-yellow-100 to-yellow-400 bg-clip-text text-4xl uppercase tracking-tight text-transparent font-[family-name:var(--font-game)]"
            style={{
              WebkitTextStroke: "1.5px #4a2e05",
              textShadow: "0 3px 0 #4a2e05, 0 0 16px rgba(250,204,21,0.85), 0 0 30px rgba(250,204,21,0.55)",
            }}
          >
            You Survived!
          </h2>
          {isProgressiveRun && (
            <div className="flex flex-col items-center gap-2">
              <div className="flex flex-col items-center gap-0.5">
                <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-yellow-300/90">
                  🔓 New Location Unlocked
                </span>
                <p
                  className="bg-gradient-to-b from-yellow-100 to-yellow-400 bg-clip-text text-xl uppercase tracking-wide text-transparent font-[family-name:var(--font-game)]"
                  style={{
                    WebkitTextStroke: "1px #4a2e05",
                    textShadow: "0 2px 0 #4a2e05, 0 0 12px rgba(250,204,21,0.7)",
                  }}
                >
                  {justUnlockedLocation}
                </p>
                <span className="text-xs font-semibold text-yellow-300/80">Level {soloStartLevel}</span>
              </div>
              <button
                onClick={() => {
                  setHighlightLocation(locationIndexForLevel(soloStartLevel));
                  setShowLocations(true);
                }}
                className="rounded-full border-2 border-blue-400/70 bg-gradient-to-b from-blue-600/90 to-blue-900/90 px-5 py-2 text-sm font-bold shadow-[0_0_16px_2px_rgba(59,130,246,0.5)] active:scale-95 transition-transform"
              >
                🗺️ View New Location
              </button>
            </div>
          )}
          <p className="text-lg">
            Your Score: <span className="font-bold">{score.toLocaleString()}</span>
          </p>
          <p className="text-sm text-white/70">
            Global High Score:{" "}
            {globalTop ? (
              <span className="font-semibold text-white">
                {globalTop.nickname} {globalTop.highScore.toLocaleString()}
              </span>
            ) : (
              <span className="font-semibold text-white">No scores yet</span>
            )}
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
            !isProgressiveRun && (
              <button
                onClick={handlePlayAgain}
                className="mt-1 rounded-full bg-blue-600 px-8 py-3 text-base font-bold shadow-lg shadow-blue-900/40 active:scale-95 transition-transform"
              >
                Play Again
              </button>
            )
          )}
          <button onClick={backToMenu} className="text-sm text-white/70 underline underline-offset-2">
            Return Back
          </button>
          <button
            onClick={handleQuit}
            className="rounded-full border border-white/20 bg-white/10 px-6 py-2 text-sm font-semibold active:scale-95 transition-transform"
          >
            Quit Game
          </button>
        </div>
      )}

      {status === "gameover" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black/65 px-6 text-center text-white font-sans">
          <h2
            className="bg-gradient-to-b from-white via-rose-100 to-rose-500 bg-clip-text text-4xl uppercase tracking-tight text-transparent font-[family-name:var(--font-game)]"
            style={{
              WebkitTextStroke: "1.5px #4a0505",
              textShadow: "0 3px 0 #4a0505, 0 0 16px rgba(244,63,94,0.85), 0 0 30px rgba(244,63,94,0.5)",
            }}
          >
            {isAlly && hostLeft ? "Host Disconnected" : "Plane Shot Down!"}
          </h2>
          <p className="text-lg">
            Your Score: <span className="font-bold">{score.toLocaleString()}</span>
          </p>
          <p className="text-sm text-white/70">
            Global High Score:{" "}
            {globalTop ? (
              <span className="font-semibold text-white">
                {globalTop.nickname} {globalTop.highScore.toLocaleString()}
              </span>
            ) : (
              <span className="font-semibold text-white">No scores yet</span>
            )}
          </p>
          {netRole !== "solo" && (
            <p className="text-sm text-white/70">
              Host: <span className="font-semibold text-white">{scores[0] ?? 0}</span> · Ally:{" "}
              <span className="font-semibold text-white">{scores[1] ?? 0}</span>
            </p>
          )}
          <p className="text-sm text-white/70">Your Best Score: {best.toLocaleString()}</p>
          {isAlly ? (
            <p className="text-sm text-white/70">Waiting for host…</p>
          ) : (
            <button
              onClick={handlePlayAgain}
              className="mt-1 rounded-full bg-blue-600 px-8 py-3 text-base font-bold shadow-lg shadow-blue-900/40 active:scale-95 transition-transform"
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
          <p className="text-sm text-white/70">Your Best Score: {best}</p>
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
