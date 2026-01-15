import { getLeadingMention, isLeadingUbiquityMention } from "./mention.ts";
import { parseLeadingSlashCommand, startsWithSlashCommand, type SlashCommandInvocation } from "./slash-command.ts";

export type ReactionType = "ignore" | "reflex" | "low_cognition" | "high_cognition";

export type ReflexType = "slash" | "personal_agent" | null;

export type TextIngressReaction = Readonly<{
  body: string;
  reaction: ReactionType;
  reflex: ReflexType;
  slashInvocation: SlashCommandInvocation | null;
  leadingMention: string | null;
  isUbiquityMention: boolean;
}>;

export function classifyTextIngress(body: string | null | undefined): TextIngressReaction {
  const normalized = typeof body === "string" ? body.trim() : "";
  const slashInvocation = parseLeadingSlashCommand(normalized);
  const isSlashCommand = startsWithSlashCommand(normalized);
  const leadingMention = getLeadingMention(normalized);
  const isUbiquityMention = isLeadingUbiquityMention(normalized);

  if (isSlashCommand) {
    return {
      body: normalized,
      reaction: "reflex",
      reflex: "slash",
      slashInvocation,
      leadingMention,
      isUbiquityMention,
    };
  }

  if (leadingMention && !isUbiquityMention) {
    return {
      body: normalized,
      reaction: "reflex",
      reflex: "personal_agent",
      slashInvocation: null,
      leadingMention,
      isUbiquityMention: false,
    };
  }

  if (isUbiquityMention) {
    return {
      body: normalized,
      reaction: "low_cognition",
      reflex: null,
      slashInvocation: null,
      leadingMention,
      isUbiquityMention: true,
    };
  }

  return {
    body: normalized,
    reaction: "ignore",
    reflex: null,
    slashInvocation: null,
    leadingMention,
    isUbiquityMention: false,
  };
}
