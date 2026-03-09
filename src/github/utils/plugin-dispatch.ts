import { Manifest } from "@ubiquity-os/plugin-sdk/manifest";
import { GitHubContext } from "../github-context.ts";
import { GithubPlugin } from "../types/plugin-configuration.ts";
import { PluginInput } from "../types/plugin.ts";
import { withKernelContextWorkflowInputsIfNeeded } from "./plugin-dispatch-settings.ts";
import { getManifest, getManifestResolution, getWorkerUrlFromManifest } from "./plugins.ts";
import { dispatchWorker, dispatchWorkflow, dispatchWorkflowWithRunUrl, getDefaultBranch } from "./workflow-dispatch.ts";

export type PluginDispatchTarget =
  | { kind: "worker"; targetUrl: string; ref: string }
  | { kind: "workflow"; owner: string; repository: string; workflowId: string; ref: string };

type ResolveDispatchTargetOptions = {
  context: GitHubContext;
  plugin: string | GithubPlugin;
  manifest?: Manifest | null;
  manifestRef?: string;
};

export async function resolvePluginDispatchTarget({ context, plugin, manifest, manifestRef }: ResolveDispatchTargetOptions): Promise<PluginDispatchTarget> {
  let resolvedManifest = manifest ?? null;
  const workerUrlFromProvidedManifest = getWorkerUrlFromManifest(resolvedManifest);
  if (workerUrlFromProvidedManifest) {
    return { kind: "worker", targetUrl: workerUrlFromProvidedManifest, ref: workerUrlFromProvidedManifest };
  }

  let resolvedManifestRef = manifestRef;
  if (typeof plugin !== "string" && !resolvedManifest) {
    const manifestResolution = await getManifestResolution(context, plugin);
    resolvedManifest ??= manifestResolution.manifest;
    resolvedManifestRef ??= manifestResolution.ref;
  } else if (!resolvedManifest) {
    resolvedManifest = await getManifest(context, plugin);
  }

  const workerUrl = getWorkerUrlFromManifest(resolvedManifest);
  if (workerUrl) {
    return { kind: "worker", targetUrl: workerUrl, ref: workerUrl };
  }
  if (typeof plugin === "string") {
    return { kind: "worker", targetUrl: plugin, ref: plugin };
  }
  const ref = resolvedManifestRef ?? plugin.ref ?? (await getDefaultBranch(context, plugin.owner, plugin.repo));
  return { kind: "workflow", owner: plugin.owner, repository: plugin.repo, workflowId: plugin.workflowId, ref };
}

type DispatchPluginTargetOptions = {
  context: GitHubContext;
  plugin: string | GithubPlugin;
  target: PluginDispatchTarget;
  pluginInput: PluginInput;
  withRunUrl?: boolean;
  getKernelPublicKeyPem: () => Promise<string>;
};

export type PluginDispatchResult = {
  target: PluginDispatchTarget;
  response?: unknown;
  runUrl?: string | null;
};

export async function dispatchPluginTarget({
  context,
  plugin,
  target,
  pluginInput,
  withRunUrl = false,
  getKernelPublicKeyPem,
}: DispatchPluginTargetOptions): Promise<PluginDispatchResult> {
  if (target.kind === "worker") {
    const response = await dispatchWorker(target.targetUrl, await pluginInput.getInputs());
    return { target, response };
  }

  const baseInputs = (await pluginInput.getInputs()) as Record<string, string>;
  const workflowInputs = await withKernelContextWorkflowInputsIfNeeded(baseInputs, plugin, getKernelPublicKeyPem);

  if (withRunUrl) {
    const runUrl = await dispatchWorkflowWithRunUrl(context, {
      owner: target.owner,
      repository: target.repository,
      workflowId: target.workflowId,
      ref: target.ref,
      inputs: workflowInputs,
    });
    return { target, runUrl };
  }

  await dispatchWorkflow(context, {
    owner: target.owner,
    repository: target.repository,
    workflowId: target.workflowId,
    ref: target.ref,
    inputs: workflowInputs,
  });
  return { target };
}
