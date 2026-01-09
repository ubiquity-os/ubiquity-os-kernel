import { GitHubContext } from "../github-context.ts";
import { callUbqAiRouter } from "../utils/ai-router.ts";

export type RouterDecision =
  | { action: "help" }
  | { action: "ignore" }
  | { action: "reply"; reply: string }
  | { action: "command"; command: { name: string; parameters?: unknown } }
  | { action: "agent"; task?: string };

function stripCodeFences(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  return trimmed
    .replace(/^```[a-zA-Z0-9_-]*\s*/, "")
    .replace(/```$/, "")
    .trim();
}

export function tryParseRouterDecision(raw: string): RouterDecision | null {
  const cleaned = stripCodeFences(raw);
  try {
    return JSON.parse(cleaned) as RouterDecision;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;
    try {
      return JSON.parse(cleaned.slice(start, end + 1)) as RouterDecision;
    } catch {
      return null;
    }
  }
}

export async function getRouterDecision(
  context: GitHubContext,
  prompt: string,
  routerInput: Record<string, unknown>
): Promise<{ raw: string; decision: RouterDecision | null } | null> {
  let raw: string;
  try {
    raw = await callUbqAiRouter(context, prompt, routerInput);
  } catch (error) {
    context.logger.error({ err: error }, "Router call failed; ignoring mention");
    return null;
  }

  context.logger.debug({ raw }, "Router output");
  return { raw, decision: tryParseRouterDecision(raw) };
}
