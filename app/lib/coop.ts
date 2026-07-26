import Pusher, { type PresenceChannel } from "pusher-js";

export const MAX_PLAYERS = 2;

let pusherSingleton: Pusher | null = null;
let clientIdSingleton: string | null = null;

export function getClientId(): string {
  if (!clientIdSingleton) {
    clientIdSingleton =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `pilot-${Math.random().toString(36).slice(2)}`;
  }
  return clientIdSingleton;
}

export function getPusherClient(): Pusher {
  if (!pusherSingleton) {
    const key = process.env.NEXT_PUBLIC_PUSHER_KEY;
    const cluster = process.env.NEXT_PUBLIC_PUSHER_CLUSTER;
    if (!key || !cluster) {
      throw new Error("Missing NEXT_PUBLIC_PUSHER_KEY / NEXT_PUBLIC_PUSHER_CLUSTER");
    }
    pusherSingleton = new Pusher(key, {
      cluster,
      channelAuthorization: {
        endpoint: "/api/pusher/auth",
        transport: "ajax",
        params: { client_id: getClientId(), display_name: "Pilot" },
      },
    });
  }
  return pusherSingleton;
}

export function roomChannelName(code: string): string {
  return `presence-skyfighter-room-${code}`;
}

export function generateRoomCode(): string {
  return String(Math.floor(100 + Math.random() * 900));
}

export function subscribeToRoom(code: string): PresenceChannel {
  return getPusherClient().subscribe(roomChannelName(code)) as PresenceChannel;
}

export function leaveRoom(code: string) {
  getPusherClient().unsubscribe(roomChannelName(code));
}

// --- Wire message shapes -----------------------------------------------

export interface InputMessage {
  id: string;
  x: number;
  y: number;
}

export interface ChatMessage {
  id: string;
  text: string;
}

// Sent by the ally to ask the host (the only client that actually
// simulates) to fire the shared ultimate -- the host validates it's
// actually charged before doing anything, same as if it had tapped its own
// button.
export interface UltimateMessage {
  id: string;
}

// Same relay shape/purpose as UltimateMessage above, for the one-tap "Boss
// Blast" special attack -- the host validates it's actually off cooldown
// before doing anything.
export interface BossBlastMessage {
  id: string;
}

export interface StartMessage {
  level: number;
  playerIds: string[];
}

export interface NetPlayer {
  id: string;
  x: number;
  y: number;
  invuln: number;
  score: number;
  // Only used by the ally client to detect "a Rapid Fire pickup just
  // happened" (a rise since the last snapshot) so it can play the sound --
  // not used for any visual/gameplay effect on the ally side.
  rapidFireUntil: number;
}

export interface NetSnapshot {
  status: "playing" | "levelcomplete" | "gameover";
  width: number;
  height: number;
  level: number;
  levelDuration: number;
  elapsed: number;
  score: number;
  lives: number;
  shieldTotal: number;
  // Co-op revive: which player id (if any) is currently down, waiting for
  // their teammate to fly close enough to revive them.
  downedPlayerId: string | null;
  // Shared ultimate meter, 0-100 -- either player can fire it once full.
  ultimateCharge: number;
  // Whether the one-tap Boss Blast special is currently off cooldown.
  bossBlastReady: boolean;
  players: NetPlayer[];
  enemies: {
    x: number;
    y: number;
    vy: number;
    scale: number;
    phase: number;
    amp: number;
    orbit?: { cx: number; cy: number; radius: number; angle: number; speed: number };
    isBoss?: boolean;
    hp?: number;
    maxHp?: number;
    kind?: "dodger" | "tanky" | "elite";
  }[];
  missiles: { x: number; y: number; vx: number; vy: number; fromBoss?: boolean }[];
  bombs: { x: number; y: number; vy: number; rot: number; fromBoss?: boolean }[];
  bullets: { x: number; y: number; vy: number; rapid: boolean; heavy?: boolean }[];
  shields: { x: number; y: number; vy: number }[];
  rapidFires: { x: number; y: number; vy: number }[];
  smartBombs: { x: number; y: number; vy: number }[];
}
