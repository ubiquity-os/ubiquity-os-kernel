import { assertEquals } from "jsr:@std/assert";
import { advanceOwnerBackoff, emptyOwnerBackoff, MAX_BACKOFF_MS, parseBackoffProgression, parseOwnerBackoff } from "../gate/src/owner-backoff.ts";

Deno.test("owner backoff: probe and burst progressions are independent", () => {
  let state = emptyOwnerBackoff();
  state = advanceOwnerBackoff(state, "probe", 1_000);
  assertEquals(state.probeUntil, 31_000);
  state = advanceOwnerBackoff(state, "probe", 31_000);
  assertEquals(state.probeUntil, 91_000);
  state = advanceOwnerBackoff(state, "burst", 31_000);
  assertEquals(state.burstUntil, 931_000);
  assertEquals(state.burstStage, 1);
  assertEquals(state.probeStage, 2);
  state = advanceOwnerBackoff(state, "burst", 931_000);
  assertEquals(state.burstUntil, 2_731_000);
});

Deno.test("owner backoff: active deadlines do not slide and both delays cap at 30 days", () => {
  for (const kind of ["probe", "burst"] as const) {
    let now = 1_000;
    let state = advanceOwnerBackoff(emptyOwnerBackoff(), kind, now);
    assertEquals(advanceOwnerBackoff(state, kind, now + 1), state);
    for (let i = 0; i < 40; i++) {
      now = Math.max(state.probeUntil, state.burstUntil);
      state = advanceOwnerBackoff(state, kind, now);
    }
    assertEquals(Math.max(state.probeUntil, state.burstUntil) - now, MAX_BACKOFF_MS);
    assertEquals(parseOwnerBackoff(JSON.stringify(state)), state);
  }
});

Deno.test("owner backoff: malformed durable records cannot create cooldowns", () => {
  for (const value of [
    null,
    "{",
    {},
    { stage: 8, nextProbeAt: 1_000 },
    { ...emptyOwnerBackoff(), burstStage: -1 },
    { ...emptyOwnerBackoff(), probeStage: 0.5 },
    { ...emptyOwnerBackoff(), burstStage: 1e20 },
    { ...emptyOwnerBackoff(), burstUntil: Infinity },
    { ...emptyOwnerBackoff(), probeUntil: NaN },
  ]) {
    assertEquals(parseOwnerBackoff(value), null);
  }
});

Deno.test("owner backoff: each durable progression validates independently", () => {
  assertEquals(parseBackoffProgression('{"stage":3,"until":123000}'), { stage: 3, until: 123000 });
  for (const value of [
    null,
    "{",
    {},
    { stage: -1, until: 0 },
    { stage: 1.5, until: 0 },
    { stage: 33, until: 0 },
    { stage: 1, until: Infinity },
    { stage: 1, until: -1 },
  ]) {
    assertEquals(parseBackoffProgression(value), null);
  }
});
