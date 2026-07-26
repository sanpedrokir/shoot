// Lifetime stats persist across every run (unlike score/level, which reset
// per playthrough) purely to drive achievement checks -- there's no
// leaderboard tied to these, just the unlock moment itself.
export interface LifetimeStats {
  kills: number;
  shieldsCollected: number;
  bossKills: number;
  coopGamesPlayed: number;
}

const STATS_KEY = "skyfighter-lifetime-stats";
const UNLOCKED_KEY = "skyfighter-achievements-unlocked";

const DEFAULT_STATS: LifetimeStats = { kills: 0, shieldsCollected: 0, bossKills: 0, coopGamesPlayed: 0 };

export function readLifetimeStats(): LifetimeStats {
  if (typeof window === "undefined") return { ...DEFAULT_STATS };
  try {
    const raw = window.localStorage.getItem(STATS_KEY);
    if (!raw) return { ...DEFAULT_STATS };
    const parsed = JSON.parse(raw);
    return {
      kills: parsed.kills ?? 0,
      shieldsCollected: parsed.shieldsCollected ?? 0,
      bossKills: parsed.bossKills ?? 0,
      coopGamesPlayed: parsed.coopGamesPlayed ?? 0,
    };
  } catch {
    return { ...DEFAULT_STATS };
  }
}

export function writeLifetimeStats(stats: LifetimeStats) {
  try {
    window.localStorage.setItem(STATS_KEY, JSON.stringify(stats));
  } catch {
    // ignore
  }
}

export function readUnlockedAchievements(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(UNLOCKED_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function writeUnlockedAchievements(ids: string[]) {
  try {
    window.localStorage.setItem(UNLOCKED_KEY, JSON.stringify(ids));
  } catch {
    // ignore
  }
}

export interface Achievement {
  id: string;
  label: string;
  description: string;
  icon: string;
  check: (stats: LifetimeStats, maxLevel: number) => boolean;
}

export const ACHIEVEMENTS: Achievement[] = [
  { id: "first-blood", label: "First Blood", description: "Destroy your first enemy plane", icon: "🎯", check: (s) => s.kills >= 1 },
  { id: "gunner", label: "Gunner", description: "Destroy 100 enemy planes", icon: "🔫", check: (s) => s.kills >= 100 },
  { id: "ace", label: "Ace Pilot", description: "Destroy 1,000 enemy planes", icon: "🥇", check: (s) => s.kills >= 1000 },
  { id: "survivor", label: "Survivor", description: "Reach Level 10", icon: "🪖", check: (_s, lvl) => lvl >= 10 },
  { id: "deep-diver", label: "Deep Diver", description: "Reach Level 25", icon: "🌌", check: (_s, lvl) => lvl >= 25 },
  { id: "legend", label: "Legend", description: "Reach Level 50", icon: "👑", check: (_s, lvl) => lvl >= 50 },
  { id: "collector", label: "Collector", description: "Collect 50 shields", icon: "🛡️", check: (s) => s.shieldsCollected >= 50 },
  { id: "boss-slayer", label: "Boss Slayer", description: "Defeat a Monster boss", icon: "💀", check: (s) => s.bossKills >= 1 },
  { id: "wingman", label: "Wingman", description: "Complete a co-op game", icon: "🤝", check: (s) => s.coopGamesPlayed >= 1 },
];

// Returns whichever achievements just newly crossed their threshold (weren't
// already unlocked), and persists the updated unlocked set. Call this right
// after updating lifetime stats.
export function checkForNewUnlocks(stats: LifetimeStats, maxLevel: number): Achievement[] {
  const unlocked = new Set(readUnlockedAchievements());
  const newly: Achievement[] = [];
  for (const a of ACHIEVEMENTS) {
    if (!unlocked.has(a.id) && a.check(stats, maxLevel)) {
      unlocked.add(a.id);
      newly.push(a);
    }
  }
  if (newly.length > 0) writeUnlockedAchievements([...unlocked]);
  return newly;
}
