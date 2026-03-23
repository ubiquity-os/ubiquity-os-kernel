import { authenticPersonality } from "./authentic.ts";
import { relatablePersonality } from "./relatable.ts";
import type { PersonalityCollection } from "./types.ts";

export const PERSONALITY_COLLECTIONS = {
  authentic: authenticPersonality,
  relatable: relatablePersonality,
} as const;

export type RouterPersonalityName = keyof typeof PERSONALITY_COLLECTIONS;
export type { PersonalityCollection };
