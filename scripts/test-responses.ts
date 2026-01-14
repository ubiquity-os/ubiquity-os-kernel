import { getErrorReply } from "../src/github/utils/router-error-messages.ts";
import type { RouterPersonalityName } from "../src/github/utils/router-personalities/index.ts";

const STATUS_CODES = [400, 401, 403, 408, 422, 429, 500, 502, 503, 504];
const PERSONALITIES: RouterPersonalityName[] = ["authentic", "relatable"];

function printSamples(): void {
  for (const personality of PERSONALITIES) {
    console.log(`\n=== ${personality} personality ===`);
    STATUS_CODES.forEach((status) => {
      const detail = `Mock detail payload for ${status}`;
      const reply = getErrorReply(status, detail, personality);
      console.log(`[${status}] ${reply}`);
    });
  }
}

printSamples();
