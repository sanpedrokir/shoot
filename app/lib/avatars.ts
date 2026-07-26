// Starter avatar set — placeholders until real player-submitted art replaces
// them. `id` is what's stored in the DB and sent over the API; adding a new
// avatar later is just dropping a file in public/avatars and adding a row
// here, no migration needed.
export interface AvatarOption {
  id: string;
  label: string;
  src: string;
}

export const AVATAR_OPTIONS: AvatarOption[] = [
  { id: "pilot", label: "Pilot", src: "/avatars/avatar-pilot.svg" },
  { id: "astronaut", label: "Astronaut", src: "/avatars/avatar-astronaut.svg" },
  { id: "robot", label: "Robot", src: "/avatars/avatar-robot.svg" },
  { id: "alien", label: "Alien", src: "/avatars/avatar-alien.svg" },
  { id: "falcon", label: "Falcon", src: "/avatars/avatar-falcon.svg" },
  { id: "rocket", label: "Rocket", src: "/avatars/avatar-rocket.svg" },
];

const AVATAR_BY_ID = new Map(AVATAR_OPTIONS.map((a) => [a.id, a]));

export function isValidAvatarId(id: string): boolean {
  return AVATAR_BY_ID.has(id);
}

// Resolves a stored avatar id to an image src, falling back to a neutral
// silhouette for players who haven't picked one yet.
export function avatarSrcFor(id: string | null | undefined): string {
  if (id) {
    const found = AVATAR_BY_ID.get(id);
    if (found) return found.src;
  }
  return "/avatars/avatar-default.svg";
}
