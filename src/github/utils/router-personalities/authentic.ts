import type { PersonalityCollection } from "./types.ts";

const BEGINNINGS = [
  "Router logic stalled:",
  "Routing stalled:",
  "Signal glitch:",
  "Connection lost to cognitive services:",
  "Cognitive services hiccup:",
  "Cognitive relay non-responsive:",
  "Processing pipeline paused:",
  "Core services unreachable:",
  "Uplink unstable:",
  "Cognitive relay offline:",
  "Process execution halted:",
  "Runtime exception caught:",
] as const;

const HOLDINGS = [
  "Graph state preserved;",
  "Holding request;",
  "Deferring;",
  "Standby;",
  "Pausing operation;",
  "Suspending task;",
  "Memory snapshot saved;",
  "Operations queued;",
  "Context persisted;",
  "Request buffer intact;",
] as const;

const INVOKES = [
  "try /help.",
  "/help available.",
  "use /help.",
  "/help works.",
  "/help ready.",
  "/help functional.",
  "Use /help for system tools.",
  "/help for commands.",
  "/help lists available tools.",
  "Try /help for manual routing.",
  "/help is online.",
  "Consult /help docs.",
  "/help for direct control.",
  "/help for fallback actions.",
] as const;

export const authenticPersonality: PersonalityCollection = {
  beginnings: BEGINNINGS,
  holdings: HOLDINGS,
  invokes: INVOKES,
};
