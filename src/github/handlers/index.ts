import { EmitterWebhookEvent, EmitterWebhookEventName } from "@octokit/webhooks";
import { logger as pinoLogger } from "../../logger/logger.ts";
import { getRequestLogTrail, readRequestIdFromLogger } from "../../logger/request-log-store.ts";
import { GitHubEventHandler } from "../github-event-handler.ts";
import { GitHubContext } from "../github-context.ts";
import { PluginInput } from "../types/plugin.ts";
import { isGithubPlugin, type PluginConfiguration } from "../types/plugin-configuration.ts";
import { getConfig, getConfigFullPathForEnvironment, type ConfigSource } from "../utils/config.ts";
import { getKernelCommit } from "../utils/kernel-metadata.ts";
import { ResolvedPlugin, getManifest, getPluginsForEvent } from "../utils/plugins.ts";
import { withKernelContextWorkflowInputsIfNeeded } from "../utils/plugin-dispatch-settings.ts";
import { dispatchWorker, dispatchWorkflow, getDefaultBranch } from "../utils/workflow-dispatch.ts";
import issueCommentCreated from "./issue-comment-created.ts";
import pullRequestReviewCommentCreated from "./pull-request-review-comment-created.ts";
import handlePushEvent from "./push-event.ts";
import { handleAgentRunCommentEdited } from "./agent-run-comment.ts";

const KERNEL_PLUGIN_ERROR_EVENT = "kernel.plugin_error" as const;
const KERNEL_PLUGIN_ERROR_EVENT_NAME = KERNEL_PLUGIN_ERROR_EVENT as unknown as EmitterWebhookEventName;
const ERROR_MESSAGE_MAX_LENGTH = 280;
const LOG_TRAIL_MAX_LINES = 40;
const LOG_TRAIL_MAX_LINE_LENGTH = 240;
const KERNEL_REPO = "ubiquity-os/ubiquity-os-kernel";

function isWorkflowLoopProtectedEvent(key: string): boolean {
  return (
    key.startsWith("workflow_") ||
    key.startsWith("check_") ||
    key.startsWith("check_run.") ||
    key.startsWith("check_suite.") ||
    key.startsWith("deployment") ||
    key.startsWith("deployment_status")
  );
}

function isDaemonHotfixPlugin(plugin: ResolvedPlugin): boolean {
  return isGithubPlugin(plugin.target) && plugin.target.repo === "daemon-hotfix";
}

function normalizeAllowlistRepos(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => typeof entry === "string")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function shouldAllowWorkflowLoopProtectedEvent(context: GitHubContext, plugin: ResolvedPlugin): boolean {
  if (!isDaemonHotfixPlugin(plugin)) return false;
  const settings = plugin.settings?.with;
  if (!settings || typeof settings !== "object") return false;

  if (!("allowWorkflowEvents" in settings) || (settings as { allowWorkflowEvents?: unknown }).allowWorkflowEvents !== true) {
    return false;
  }

  const allowlistRepos = normalizeAllowlistRepos((settings as { allowlistRepos?: unknown }).allowlistRepos);
  if (!allowlistRepos.length) return true;
  const repo = String((context.payload as { repository?: { full_name?: unknown } })?.repository?.full_name ?? "")
    .trim()
    .toLowerCase();
  return repo ? allowlistRepos.includes(repo) : false;
}

function readHttpStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  if ("status" in error && typeof (error as { status?: unknown }).status === "number") {
    return (error as { status: number }).status;
  }
  if ("statusCode" in error && typeof (error as { statusCode?: unknown }).statusCode === "number") {
    return (error as { statusCode: number }).statusCode;
  }
  const message = "message" in error && typeof (error as { message?: unknown }).message === "string" ? (error as { message: string }).message : "";
  const match = /^HTTP\s+(\d{3})\b/.exec(message);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}

function readErrorMessage(error: unknown): string {
  let raw = "Unknown error";
  if (typeof error === "string") {
    raw = error;
  } else if (error && typeof error === "object" && "message" in error && typeof (error as { message?: unknown }).message === "string") {
    raw = (error as { message: string }).message;
  }
  const trimmed = raw.trim();
  const normalized = trimmed.length > ERROR_MESSAGE_MAX_LENGTH ? `${trimmed.slice(0, ERROR_MESSAGE_MAX_LENGTH)}...` : trimmed;
  return redactSecrets(normalized);
}

function extractTriggerIssueOrPrNumber(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") return null;
  if ("issue" in payload && payload.issue && typeof payload.issue === "object" && "number" in payload.issue) {
    const n = (payload.issue as { number?: unknown }).number;
    if (typeof n === "number" && Number.isFinite(n)) return Math.trunc(n);
  }
  if ("pull_request" in payload && payload.pull_request && typeof payload.pull_request === "object" && "number" in payload.pull_request) {
    const n = (payload.pull_request as { number?: unknown }).number;
    if (typeof n === "number" && Number.isFinite(n)) return Math.trunc(n);
  }
  return null;
}

function extractSenderLogin(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  if (!("sender" in payload) || !payload.sender || typeof payload.sender !== "object") return "";
  const login = (payload.sender as { login?: unknown }).login;
  return typeof login === "string" ? login : "";
}

function extractRepositoryFullName(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  if (!("repository" in payload) || !payload.repository || typeof payload.repository !== "object") return "";
  const fullName = (payload.repository as { full_name?: unknown }).full_name;
  if (typeof fullName === "string" && fullName.trim()) return fullName;

  const owner = (payload.repository as { owner?: { login?: unknown } }).owner?.login;
  const name = (payload.repository as { name?: unknown }).name;
  if (typeof owner === "string" && typeof name === "string" && owner && name) return `${owner}/${name}`;
  return "";
}

function parseOwnerRepo(value: unknown): { owner: string; repo: string } | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const match = /^([0-9A-Za-z_.-]+)\/([0-9A-Za-z_.-]+)$/.exec(trimmed);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

function redactSecrets(value: string): string {
  return value.replace(/Bearer\s+\S+/giu, "Bearer [REDACTED]").replace(/(ghp|gho|ghs|ghr|ghu|github_pat)_[A-Za-z0-9_]+/giu, "[REDACTED]");
}

function sanitizeLogLine(line: string): string {
  const trimmed = line.trim();
  const capped = trimmed.length > LOG_TRAIL_MAX_LINE_LENGTH ? `${trimmed.slice(0, LOG_TRAIL_MAX_LINE_LENGTH)}...` : trimmed;
  return redactSecrets(capped);
}

function sanitizeLogTrail(logTrail: ReturnType<typeof getRequestLogTrail> | null) {
  if (!logTrail) return null;
  return {
    requestId: logTrail.requestId,
    startedAt: logTrail.startedAt,
    durationMs: logTrail.durationMs,
    lines: logTrail.lines.slice(0, LOG_TRAIL_MAX_LINES).map((line) => sanitizeLogLine(line)),
  };
}

async function tryGetRepoInstallationId(eventHandler: GitHubEventHandler, owner: string, repo: string): Promise<number | null> {
  try {
    const octokit = eventHandler.getUnauthenticatedOctokit();
    const { data } = await octokit.request("GET /repos/{owner}/{repo}/installation", { owner, repo });
    const id = (data as { id?: unknown })?.id;
    return typeof id === "number" && Number.isFinite(id) ? Math.trunc(id) : null;
  } catch {
    return null;
  }
}

type KernelMetadata = {
  commit: string;
};

type ConfigWithSources = PluginConfiguration & { __sources?: ConfigSource[] };

function buildKernelPluginErrorPayload({
  stateId,
  context,
  pluginEntry,
  ref,
  error,
  authContextRepo,
  authInstallationId,
  safePluginWith,
  kernel,
  configSources,
  requestId,
  logTrail,
}: {
  stateId: string;
  context: GitHubContext;
  pluginEntry: ResolvedPlugin;
  ref: string;
  error: unknown;
  authContextRepo: { owner: string; repo: string } | null;
  authInstallationId: number | null;
  safePluginWith: Record<string, unknown>;
  kernel: KernelMetadata;
  configSources: ConfigSource[];
  requestId: string | null;
  logTrail: ReturnType<typeof getRequestLogTrail> | null;
}) {
  const triggerRepo = extractRepositoryFullName(context.payload);
  const issueOrPr = extractTriggerIssueOrPrNumber(context.payload);
  const actor = extractSenderLogin(context.payload);
  const pluginTarget = pluginEntry.target;
  const isWorkflow = isGithubPlugin(pluginTarget);
  const configPath = getConfigFullPathForEnvironment(context.eventHandler.environment);

  const pluginType = isWorkflow ? "workflow" : "http";
  const pluginId = isWorkflow ? `${pluginTarget.owner}/${pluginTarget.repo}:${pluginTarget.workflowId}@${ref}` : String(pluginTarget);

  const payloadRepo = authContextRepo
    ? {
        owner: { login: authContextRepo.owner },
        name: authContextRepo.repo,
        full_name: `${authContextRepo.owner}/${authContextRepo.repo}`,
      }
    : {
        owner: { login: triggerRepo.split("/")[0] ?? "" },
        name: triggerRepo.split("/")[1] ?? "",
        full_name: triggerRepo,
      };

  return {
    event: KERNEL_PLUGIN_ERROR_EVENT,
    timestamp: new Date().toISOString(),
    stateId,
    environment: context.eventHandler.environment,
    configPath,
    config: {
      path: configPath,
      sources: configSources,
    },
    kernel,
    source: {
      kernelRepo: KERNEL_REPO,
      environment: context.eventHandler.environment,
    },
    trigger: {
      githubEvent: context.key,
      deliveryId: context.id,
      repo: triggerRepo,
      issueOrPr,
      actor,
    },
    plugin: {
      type: pluginType,
      id: pluginId,
      owner: isWorkflow ? pluginTarget.owner : undefined,
      repo: isWorkflow ? pluginTarget.repo : undefined,
      workflowId: isWorkflow ? pluginTarget.workflowId : undefined,
      ref,
      settings: Object.keys(safePluginWith).length ? { with: safePluginWith } : undefined,
    },
    error: {
      message: readErrorMessage(error),
      status: readHttpStatus(error),
      category: pluginType,
    },
    context: {
      retryCount: 0,
      requestId,
    },
    logTrail: sanitizeLogTrail(logTrail) ?? undefined,
    repository: payloadRepo,
    installation: authInstallationId ? { id: authInstallationId } : undefined,
  };
}

function buildKernelErrorPayload({
  stateId,
  context,
  error,
  authContextRepo,
  authInstallationId,
  kernel,
  configSources,
  requestId,
  logTrail,
}: {
  stateId: string;
  context: GitHubContext;
  error: unknown;
  authContextRepo: { owner: string; repo: string } | null;
  authInstallationId: number | null;
  kernel: KernelMetadata;
  configSources: ConfigSource[];
  requestId: string | null;
  logTrail: ReturnType<typeof getRequestLogTrail> | null;
}) {
  const triggerRepo = extractRepositoryFullName(context.payload);
  const issueOrPr = extractTriggerIssueOrPrNumber(context.payload);
  const actor = extractSenderLogin(context.payload);
  const parsedTrigger = parseOwnerRepo(triggerRepo);
  const triggerOwner = parsedTrigger?.owner ?? "";
  const triggerName = parsedTrigger?.repo ?? "";
  const kernelId = KERNEL_REPO;
  const configPath = getConfigFullPathForEnvironment(context.eventHandler.environment);

  const payloadRepo = authContextRepo
    ? {
        owner: { login: authContextRepo.owner },
        name: authContextRepo.repo,
        full_name: `${authContextRepo.owner}/${authContextRepo.repo}`,
      }
    : {
        owner: { login: triggerOwner },
        name: triggerName,
        full_name: triggerRepo,
      };

  return {
    event: KERNEL_PLUGIN_ERROR_EVENT,
    timestamp: new Date().toISOString(),
    stateId,
    environment: context.eventHandler.environment,
    configPath,
    config: {
      path: configPath,
      sources: configSources,
    },
    kernel,
    source: {
      kernelRepo: KERNEL_REPO,
      environment: context.eventHandler.environment,
    },
    trigger: {
      githubEvent: context.key,
      deliveryId: context.id,
      repo: triggerRepo,
      issueOrPr,
      actor,
    },
    plugin: {
      type: "kernel",
      id: kernelId,
      owner: triggerOwner || undefined,
      repo: triggerName || undefined,
      ref: kernel.commit,
    },
    error: {
      message: readErrorMessage(error),
      status: readHttpStatus(error),
      category: "kernel",
    },
    context: {
      retryCount: 0,
      requestId,
    },
    logTrail: sanitizeLogTrail(logTrail) ?? undefined,
    repository: payloadRepo,
    installation: authInstallationId ? { id: authInstallationId } : undefined,
  };
}

async function emitKernelPluginErrorEvent({
  context,
  config,
  failingPluginEntry,
  failingRef,
  failingStateId,
  error,
  triggeringInstallationId,
  triggeringAuthToken,
}: {
  context: GitHubContext;
  config: PluginConfiguration;
  failingPluginEntry: ResolvedPlugin;
  failingRef: string;
  failingStateId: string;
  error: unknown;
  triggeringInstallationId: number;
  triggeringAuthToken: string;
}) {
  const subscribers = await getPluginsForEvent(context, config.plugins, KERNEL_PLUGIN_ERROR_EVENT_NAME);
  if (!subscribers.length) return;

  let targetRepo: { owner: string; repo: string } | null = null;
  const failingSettings = failingPluginEntry.settings;
  if (failingSettings && typeof failingSettings === "object") {
    const settingsWith = failingSettings.with;
    if (settingsWith && typeof settingsWith === "object") {
      targetRepo = parseOwnerRepo((settingsWith as { sourceRepo?: unknown }).sourceRepo);
    }
  }

  const safePluginWith: Record<string, unknown> = {};
  const failingWith = failingPluginEntry.settings?.with;
  if (failingWith && typeof failingWith === "object") {
    if ("sourceRepo" in failingWith) safePluginWith.sourceRepo = (failingWith as { sourceRepo?: unknown }).sourceRepo;
    if ("sourceRef" in failingWith) safePluginWith.sourceRef = (failingWith as { sourceRef?: unknown }).sourceRef;
  }

  const targetInstallationId = targetRepo ? await tryGetRepoInstallationId(context.eventHandler, targetRepo.owner, targetRepo.repo) : null;
  const authInstallationId = targetInstallationId ?? triggeringInstallationId;
  const authContextRepo = targetInstallationId && targetRepo ? targetRepo : parseOwnerRepo(extractRepositoryFullName(context.payload));
  const authToken = targetInstallationId ? await context.eventHandler.getToken(targetInstallationId) : triggeringAuthToken;

  const kernelMeta = {
    commit: await getKernelCommit(),
  };
  const requestId = readRequestIdFromLogger(context.logger);
  const logTrail = requestId ? getRequestLogTrail(requestId) : null;
  const configSources = (config as ConfigWithSources).__sources ?? [];

  const payload = buildKernelPluginErrorPayload({
    stateId: failingStateId,
    context,
    pluginEntry: failingPluginEntry,
    ref: failingRef,
    error,
    authContextRepo,
    authInstallationId,
    safePluginWith,
    kernel: kernelMeta,
    configSources,
    requestId,
    logTrail,
  });

  for (const pluginEntry of subscribers) {
    const plugin = pluginEntry.target;
    const settings = pluginEntry.settings;
    const isGithub = isGithubPlugin(plugin);
    const stateId = crypto.randomUUID();
    const ref = isGithub ? (plugin.ref ?? (await getDefaultBranch(context, plugin.owner, plugin.repo))) : String(plugin);
    const eventPayload = payload as unknown as EmitterWebhookEvent<EmitterWebhookEventName>["payload"];
    const inputs = new PluginInput(context.eventHandler, stateId, KERNEL_PLUGIN_ERROR_EVENT_NAME, eventPayload, settings?.with, authToken, ref, null);

    try {
      context.logger.debug({ plugin: pluginEntry.key }, `Dispatching ${KERNEL_PLUGIN_ERROR_EVENT}`);
      if (!isGithub) {
        await dispatchWorker(String(plugin), await inputs.getInputs());
      } else {
        const baseInputs = (await inputs.getInputs()) as Record<string, string>;
        const workflowInputs = await withKernelContextWorkflowInputsIfNeeded(baseInputs, plugin, () => context.eventHandler.getKernelPublicKeyPem());
        await dispatchWorkflow(context, {
          owner: plugin.owner,
          repository: plugin.repo,
          workflowId: plugin.workflowId,
          ref,
          inputs: workflowInputs,
        });
      }
    } catch (dispatchError) {
      context.logger.error({ plugin: pluginEntry.key, err: dispatchError }, `Error dispatching ${KERNEL_PLUGIN_ERROR_EVENT}; skipping`);
    }
  }
}

async function emitKernelErrorEvent({ eventHandler, event, error }: { eventHandler: GitHubEventHandler; event: EmitterWebhookEvent; error: unknown }) {
  let context: GitHubContext;
  try {
    context = eventHandler.transformEvent(event);
  } catch (transformError) {
    eventHandler.logger.error({ err: transformError }, "Failed to transform event for kernel error dispatch");
    return;
  }

  if (context.key === KERNEL_PLUGIN_ERROR_EVENT_NAME) {
    context.logger.debug({ event: context.key }, "Skipping kernel error dispatch for kernel.plugin_error event");
    return;
  }

  const config = await getConfig(context);
  if (!config) {
    context.logger.debug("No configuration was found for kernel error dispatch");
    return;
  }

  if (!("installation" in event.payload) || event.payload.installation?.id === undefined) {
    context.logger.warn("No installation found for kernel error dispatch");
    return;
  }

  const subscribers = await getPluginsForEvent(context, config.plugins, KERNEL_PLUGIN_ERROR_EVENT_NAME);
  if (!subscribers.length) return;

  const triggeringInstallationId = event.payload.installation.id;
  const authToken = await eventHandler.getToken(triggeringInstallationId);
  const kernelMeta = {
    commit: await getKernelCommit(),
  };
  const requestId = readRequestIdFromLogger(context.logger);
  const logTrail = requestId ? getRequestLogTrail(requestId) : null;
  const configSources = (config as ConfigWithSources).__sources ?? [];
  const authContextRepo = parseOwnerRepo(extractRepositoryFullName(context.payload));
  const kernelErrorStateId = crypto.randomUUID();

  const payload = buildKernelErrorPayload({
    stateId: kernelErrorStateId,
    context,
    error,
    authContextRepo,
    authInstallationId: triggeringInstallationId,
    kernel: kernelMeta,
    configSources,
    requestId,
    logTrail,
  });

  for (const pluginEntry of subscribers) {
    const plugin = pluginEntry.target;
    const settings = pluginEntry.settings;
    const isGithub = isGithubPlugin(plugin);
    const stateId = crypto.randomUUID();
    const ref = isGithub ? (plugin.ref ?? (await getDefaultBranch(context, plugin.owner, plugin.repo))) : String(plugin);
    const eventPayload = payload as unknown as EmitterWebhookEvent<EmitterWebhookEventName>["payload"];
    const inputs = new PluginInput(context.eventHandler, stateId, KERNEL_PLUGIN_ERROR_EVENT_NAME, eventPayload, settings?.with, authToken, ref, null);

    try {
      context.logger.debug({ plugin: pluginEntry.key }, `Dispatching ${KERNEL_PLUGIN_ERROR_EVENT}`);
      if (!isGithub) {
        await dispatchWorker(String(plugin), await inputs.getInputs());
      } else {
        const baseInputs = (await inputs.getInputs()) as Record<string, string>;
        const workflowInputs = await withKernelContextWorkflowInputsIfNeeded(baseInputs, plugin, () => context.eventHandler.getKernelPublicKeyPem());
        await dispatchWorkflow(context, {
          owner: plugin.owner,
          repository: plugin.repo,
          workflowId: plugin.workflowId,
          ref,
          inputs: workflowInputs,
        });
      }
    } catch (dispatchError) {
      context.logger.error({ plugin: pluginEntry.key, err: dispatchError }, `Error dispatching ${KERNEL_PLUGIN_ERROR_EVENT}; skipping`);
    }
  }
}

function tryCatchWrapper(fn: (event: EmitterWebhookEvent) => unknown, logger: typeof pinoLogger, eventHandler: GitHubEventHandler) {
  return async (event: EmitterWebhookEvent) => {
    try {
      await fn(event);
    } catch (error) {
      logger.error({ err: error, event }, "Error in event handler");
      try {
        await emitKernelErrorEvent({ eventHandler, event, error });
      } catch (emitError) {
        logger.error({ err: emitError }, "Failed to emit kernel error event");
      }
    }
  };
}

export function bindHandlers(eventHandler: GitHubEventHandler) {
  eventHandler.on("issue_comment.created", issueCommentCreated);
  eventHandler.on("issue_comment.edited", async (context) => {
    const issueNumber = typeof context.payload?.issue?.number === "number" ? context.payload.issue.number : null;
    if (!issueNumber) {
      context.logger.debug("Missing issue number for issue_comment.edited; skipping agent run update");
      return;
    }
    await handleAgentRunCommentEdited(context as GitHubContext<"issue_comment.edited">, issueNumber);
  });
  eventHandler.on("pull_request_review_comment.created", pullRequestReviewCommentCreated);
  eventHandler.on("pull_request_review_comment.edited", async (context) => {
    const prNumber = typeof context.payload?.pull_request?.number === "number" ? context.payload.pull_request.number : null;
    if (!prNumber) {
      context.logger.debug("Missing pull request number for pull_request_review_comment.edited; skipping agent run update");
      return;
    }
    await handleAgentRunCommentEdited(context as GitHubContext<"pull_request_review_comment.edited">, prNumber);
  });
  eventHandler.on("push", handlePushEvent);
  eventHandler.on("installation.created", () => {}); // No-op to handle event
  eventHandler.onAny(tryCatchWrapper((event) => handleEvent(event, eventHandler), eventHandler.logger, eventHandler)); // onAny should also receive GithubContext but the types in octokit/webhooks are weird
}

function extractLeadingSlashCommandName(body: string): string | null {
  const trimmed = body.trimStart();
  const match = /^\/([\w-]+)/u.exec(trimmed);
  return match?.[1] ? match[1].toLowerCase() : null;
}

function extractSlashCommandNameFromCommentBody(body: string): string | null {
  const direct = extractLeadingSlashCommandName(body);
  if (direct) return direct;

  const mention = /@ubiquityos\b/i.exec(body);
  if (!mention || mention.index === undefined) return null;
  const afterMention = body.slice(mention.index + mention[0].length);
  return extractLeadingSlashCommandName(afterMention);
}

async function filterPluginsForSlashCommandEvent(context: GitHubContext, plugins: ResolvedPlugin[], slashCommandName: string): Promise<ResolvedPlugin[]> {
  const filtered: ResolvedPlugin[] = [];
  for (const plugin of plugins) {
    try {
      const manifest = await getManifest(context, plugin.target);
      if (!manifest?.commands) {
        filtered.push(plugin);
        continue;
      }
      const commandNames = Object.keys(manifest.commands).map((name) => name.toLowerCase());
      const listeners = Array.isArray(manifest["ubiquity:listeners"]) ? manifest["ubiquity:listeners"].map((name) => name.toLowerCase()) : [];
      const doesListenToEvent = listeners.includes(context.key.toLowerCase());
      if (commandNames.includes(slashCommandName)) {
        context.logger.debug({ plugin: plugin.key, command: slashCommandName }, "Skipping global dispatch for command plugin; slash handler will dispatch");
      } else if (doesListenToEvent) {
        filtered.push(plugin);
      } else {
        context.logger.debug(
          { plugin: plugin.key, command: slashCommandName },
          "Skipping global dispatch for non-matching command plugin on slash-command comment"
        );
      }
      continue;
    } catch (error) {
      context.logger.debug({ plugin: plugin.key, err: error }, "Failed to inspect plugin manifest for slash-command filtering; allowing dispatch");
    }
    filtered.push(plugin);
  }
  return filtered;
}

async function handleEvent(event: EmitterWebhookEvent, eventHandler: InstanceType<typeof GitHubEventHandler>) {
  const context = eventHandler.transformEvent(event);

  if (context.key === "deployment_status.created" || String(context.key) === "repository_dispatch.return-data-to-ubiquity-os-kernel") {
    context.logger.debug({ event: context.key }, "Skipping plugin processing for internal event");
    return;
  }

  const config = await getConfig(context);

  if (!config) {
    context.logger.debug("No configuration was found");
    return;
  }

  if (!("installation" in event.payload) || event.payload.installation?.id === undefined) {
    context.logger.warn("No installation found");
    return;
  }

  const resolvedPlugins = await getPluginsForEvent(context, config.plugins, context.key);
  if (isWorkflowLoopProtectedEvent(context.key)) {
    const allowed = resolvedPlugins.filter((plugin) => shouldAllowWorkflowLoopProtectedEvent(context, plugin));
    if (!allowed.length) {
      context.logger.debug({ event: context.key }, "Skipping plugin processing for workflow-related event to prevent loops");
      return;
    }
    resolvedPlugins.length = 0;
    resolvedPlugins.push(...allowed);
  }

  if (context.key === "issue_comment.created") {
    const issueContext = context as GitHubContext<"issue_comment.created">;
    const commandName = extractSlashCommandNameFromCommentBody(String(issueContext.payload.comment?.body ?? ""));
    if (commandName) {
      const filtered = await filterPluginsForSlashCommandEvent(context, resolvedPlugins, commandName);
      resolvedPlugins.length = 0;
      resolvedPlugins.push(...filtered);
    }
  }

  if (context.key === "pull_request_review_comment.created") {
    const reviewContext = context as GitHubContext<"pull_request_review_comment.created">;
    const commandName = extractSlashCommandNameFromCommentBody(String(reviewContext.payload.comment?.body ?? ""));
    if (commandName) {
      const filtered = await filterPluginsForSlashCommandEvent(context, resolvedPlugins, commandName);
      resolvedPlugins.length = 0;
      resolvedPlugins.push(...filtered);
    }
  }

  if (resolvedPlugins.length === 0) {
    context.logger.debug("No handler found for event");
    return;
  }

  context.logger.info({ plugins: resolvedPlugins.map((plugin) => plugin.key) }, "Will call plugins for event");

  for (const pluginEntry of resolvedPlugins) {
    const plugin = pluginEntry.target;
    const settings = pluginEntry.settings;
    context.logger.debug({ plugin: pluginEntry.key }, "Calling handler for event");

    const stateId = crypto.randomUUID();
    const token = await eventHandler.getToken(event.payload.installation.id);
    let ref = "";
    let isWorker = false;

    // We wrap the dispatch so a failing plugin doesn't break the whole execution
    try {
      if (!isGithubPlugin(plugin)) {
        isWorker = true;
        ref = plugin;
        const inputs = new PluginInput(context.eventHandler, stateId, context.key, event.payload, settings?.with, token, ref, null);
        context.logger.debug({ plugin: pluginEntry.key, worker: isWorker }, "Dispatching event");
        const res = await dispatchWorker(plugin, await inputs.getInputs());
        if (res.status >= 300) {
          context.logger.warn({ plugin: pluginEntry.key, response: await safeJson(res), workerUrl: plugin }, "Error response on dispatch event");
        }
      } else {
        ref = plugin.ref ?? "";
        if (!ref) {
          ref = await getDefaultBranch(context, plugin.owner, plugin.repo);
        }
        const inputs = new PluginInput(context.eventHandler, stateId, context.key, event.payload, settings?.with, token, ref, null);
        context.logger.debug({ plugin: pluginEntry.key, worker: isWorker }, "Dispatching event");
        const baseInputs = (await inputs.getInputs()) as Record<string, string>;
        const workflowInputs = await withKernelContextWorkflowInputsIfNeeded(baseInputs, plugin, () => eventHandler.getKernelPublicKeyPem());
        await dispatchWorkflow(context, {
          owner: plugin.owner,
          repository: plugin.repo,
          workflowId: plugin.workflowId,
          ref,
          inputs: workflowInputs,
        });
      }
      context.logger.debug({ plugin: pluginEntry.key }, "Event dispatched");
    } catch (e) {
      context.logger.error({ plugin: pluginEntry.key, err: e }, "Error processing plugin; skipping");
      await emitKernelPluginErrorEvent({
        context,
        config,
        failingPluginEntry: pluginEntry,
        failingRef: ref,
        failingStateId: stateId,
        error: e,
        triggeringInstallationId: event.payload.installation.id,
        triggeringAuthToken: token,
      });
    }
  }
}

async function safeJson(response: Response) {
  const contentType = response.headers.get("content-type");
  if (contentType && contentType.includes("application/json")) {
    return response.json();
  }
  return await response.text();
}
