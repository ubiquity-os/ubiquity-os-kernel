import type { PersonalityCollection } from "./types.ts";

const BEGINNINGS = [
  "My thinking stalled:",
  "Command pipeline down:",
  "Decision engine offline:",
  "Tool setup interrupted:",
  "Just a sec, glitch occurred:",
  "Brainstorming paused:",
] as const;

const HOLDINGS = [
  "Chat history safe;",
  "History preserved;",
  "Task paused here;",
  "Holding on to this;",
  "Saved for later;",
  "Don't worry, context kept;",
  "I remember what you said;",
  "Just a momentary pause;",
] as const;

const INVOKES = [
  "try /help for tools.",
  "/help for chat options.",
  "/help for commands.",
  "/help ready now.",
  "Check the /help manual.",
  "/help lists all moves.",
  "/help shows commands.",
  "Browse /help features.",
] as const;

export const relatablePersonality: PersonalityCollection = {
  beginnings: BEGINNINGS,
  holdings: HOLDINGS,
  invokes: INVOKES,
};
