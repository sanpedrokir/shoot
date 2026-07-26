// `id` is what's stored in the DB and sent over the API; adding a new avatar
// later is just dropping a file in public/avatars and adding a row here, no
// migration needed.
export interface AvatarOption {
  id: string;
  label: string;
  src: string;
}

export const AVATAR_OPTIONS: AvatarOption[] = [
  { id: "male-star-pilot", label: "Male Star Pilot", src: "/avatars/avatar-male-star-pilot.webp" },
  { id: "male-space-pilot", label: "Male Space Pilot", src: "/avatars/avatar-male-space-pilot.webp" },
  { id: "female-tech-warrior", label: "Female Tech Warrior", src: "/avatars/avatar-female-tech-warrior.webp" },
  { id: "female-android", label: "Female Android", src: "/avatars/avatar-female-android.webp" },
  { id: "female-alien-explorer", label: "Female Alien Explorer", src: "/avatars/avatar-female-alien-explorer.webp" },
  { id: "male-space-mechanic", label: "Male Space Mechanic", src: "/avatars/avatar-male-space-mechanic.webp" },
  { id: "female-space-soldier", label: "Female Space Soldier", src: "/avatars/avatar-female-space-soldier.webp" },
  { id: "male-space-commander", label: "Male Space Commander", src: "/avatars/avatar-male-space-commander.webp" },
  { id: "male-space-cadet", label: "Male Space Cadet", src: "/avatars/avatar-male-space-cadet.webp" },
  { id: "female-star-pilot", label: "Female Star Pilot", src: "/avatars/avatar-female-star-pilot.webp" },
  { id: "female-space-commander", label: "Female Space Commander", src: "/avatars/avatar-female-space-commander.webp" },
  { id: "female-cosmic-warrior", label: "Female Cosmic Warrior", src: "/avatars/avatar-female-cosmic-warrior.webp" },
  { id: "female-android-elite", label: "Female Android Elite", src: "/avatars/avatar-female-android-elite.webp" },
  { id: "female-alien-scout", label: "Female Alien Scout", src: "/avatars/avatar-female-alien-scout.webp" },
  { id: "male-cheerful-cadet", label: "Male Cheerful Cadet", src: "/avatars/avatar-male-cheerful-cadet.webp" },
  { id: "male-engineer", label: "Male Engineer", src: "/avatars/avatar-male-engineer.webp" },
  { id: "male-veteran-commander", label: "Male Veteran Commander", src: "/avatars/avatar-male-veteran-commander.webp" },
  { id: "male-ace-pilot", label: "Male Ace Pilot", src: "/avatars/avatar-male-ace-pilot.webp" },
  { id: "female-cosmic-scout", label: "Female Cosmic Scout", src: "/avatars/avatar-female-cosmic-scout.webp" },
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
