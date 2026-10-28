export const MAX_BACKOFF_MS = 30 * 86_400_000;
const MAX_STAGE = 32;

export type OwnerBackoff = {
  probeStage: number;
  probeUntil: number;
  burstStage: number;
  burstUntil: number;
};

export type BackoffProgression = { stage: number; until: number };

export function parseBackoffProgression(value: unknown): BackoffProgression | null {
  try {
    const state = typeof value === "string" ? JSON.parse(value) : value;
    if (!state || typeof state !== "object") return null;
    if (!Number.isInteger(state.stage) || state.stage < 0 || state.stage > MAX_STAGE) return null;
    if (!Number.isSafeInteger(state.until) || state.until < 0) return null;
    return { stage: state.stage, until: state.until };
  } catch {
    return null;
  }
}

export function emptyOwnerBackoff(): OwnerBackoff {
  return { probeStage: 0, probeUntil: 0, burstStage: 0, burstUntil: 0 };
}

export function parseOwnerBackoff(value: unknown): OwnerBackoff | null {
  try {
    const state = typeof value === "string" ? JSON.parse(value) : value;
    if (!state || typeof state !== "object") return null;
    for (const field of ["probeStage", "burstStage"] as const) {
      if (!Number.isInteger(state[field]) || state[field] < 0 || state[field] > MAX_STAGE) return null;
    }
    for (const field of ["probeUntil", "burstUntil"] as const) {
      if (!Number.isSafeInteger(state[field]) || state[field] < 0) return null;
    }
    return { probeStage: state.probeStage, probeUntil: state.probeUntil, burstStage: state.burstStage, burstUntil: state.burstUntil };
  } catch {
    return null;
  }
}

export function advanceOwnerBackoff(state: OwnerBackoff, kind: "probe" | "burst", now: number): OwnerBackoff {
  const stage = kind === "probe" ? state.probeStage : state.burstStage;
  const until = kind === "probe" ? state.probeUntil : state.burstUntil;
  if (until > now) return state;
  const delay = Math.min((kind === "probe" ? 30_000 : 900_000) * 2 ** stage, MAX_BACKOFF_MS);
  const nextStage = Math.min(stage + 1, MAX_STAGE);
  return kind === "probe" ? { ...state, probeStage: nextStage, probeUntil: now + delay } : { ...state, burstStage: nextStage, burstUntil: now + delay };
}
