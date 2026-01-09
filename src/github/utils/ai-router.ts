import { GitHubContext } from "../github-context";
import { createKernelAttestationToken } from "./kernel-attestation";

type ChatCompletion = Readonly<{
  choices?: Array<{
    message?: {
      content?: string | null;
    } | null;
  } | null> | null;
}>;

function isCloudflareAntibotHtml(status: number, html: string): boolean {
  if (status !== 403 && status !== 503) return false;
  const body = html.toLowerCase();
  return body.includes("<title>just a moment...</title>") || body.includes("cloudflare") || body.includes("cf-chl");
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

export async function callUbqAiRouter(
  context: GitHubContext,
  prompt: string,
  routerInput: unknown,
  options: Readonly<{ timeoutMs?: number; model?: string }> = {}
): Promise<string> {
  const payload = context.payload as Record<string, unknown>;
  const installation = (payload.installation as { id?: number } | undefined) ?? null;
  if (!installation?.id) {
    throw new Error("Missing installation id");
  }
  const repository = payload.repository as { owner?: { login?: string }; name?: string } | undefined;
  const owner = repository?.owner?.login ?? "";
  const repo = repository?.name ?? "";
  if (!owner || !repo) {
    throw new Error("Missing repository owner/name");
  }

  const installationId = installation.id;
  const token = await context.eventHandler.getToken(installationId);
  const kernelToken = await createKernelAttestationToken({
    sign: (payloadToSign) => context.eventHandler.signPayload(payloadToSign),
    owner,
    repo,
    installationId,
    authToken: token,
    stateId: crypto.randomUUID(),
    ttlSeconds: 120,
  });

  const payloadBody = {
    model: options.model ?? context.eventHandler.llm,
    reasoning_effort: "none",
    stream: false,
    messages: [
      { role: "system", content: prompt },
      {
        role: "user",
        content: JSON.stringify(routerInput),
      },
    ],
  };

  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "User-Agent": "ubiquity-os-kernel/router",
    "X-GitHub-Owner": owner,
    "X-GitHub-Repo": repo,
    "X-GitHub-Installation-Id": String(installationId),
    "X-Ubiquity-Kernel-Token": kernelToken,
  };

  const baseUrl = normalizeBaseUrl(context.eventHandler.aiBaseUrl);
  const endpoint = new URL("/v1/chat/completions", baseUrl).toString();
  const timeoutMs = typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs) ? Math.max(1000, options.timeoutMs) : 25_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      signal: controller.signal,
      headers,
      body: JSON.stringify(payloadBody),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      if (response.status === 403 || response.status === 503 || isCloudflareAntibotHtml(response.status, text)) {
        context.logger.warn({ status: response.status }, "Router endpoint blocked");
      }
      const snippet = text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
      throw new Error(`${endpoint} -> ${response.status} ${snippet}`);
    }

    const data = (await response.json()) as ChatCompletion;
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new Error(`${endpoint} -> ok but missing assistant content`);
    }
    return content;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Router error: ${message}`);
  } finally {
    clearTimeout(timeout);
  }
}
