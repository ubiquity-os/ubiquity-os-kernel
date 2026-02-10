import { assertEquals } from "jsr:@std/assert";

import { isLeadingUbiquityMention } from "../src/github/utils/mention.ts";
import { classifyTextIngress } from "../src/github/utils/reaction.ts";

Deno.test("mention: recognizes @ubiquityos", () => {
  assertEquals(isLeadingUbiquityMention("@ubiquityos hello"), true);
});

Deno.test("mention: recognizes @UbiquityOS_bot", () => {
  assertEquals(isLeadingUbiquityMention("@UbiquityOS_bot hello"), true);
});

Deno.test("reaction: treats @UbiquityOS_bot as a UbiquityOS mention", () => {
  const reaction = classifyTextIngress("@UbiquityOS_bot are you there?");
  assertEquals(reaction.reaction, "low_cognition");
  assertEquals(reaction.isUbiquityMention, true);
});
