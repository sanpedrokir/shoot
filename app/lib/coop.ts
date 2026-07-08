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

export interface StartMessage {
  level: number;
  playerIds: string[];
}

export interface NetPlayer {
  id: string;
  x: number;
  y: number;
  invuln: number;
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
  players: NetPlayer[];
  enemies: { x: number; y: number; scale: number; phase: number }[];
  missiles: { x: number; y: number; vx: number; vy: number }[];
  bombs: { x: number; y: number; rot: number }[];
  bullets: { x: number; y: number }[];
}
