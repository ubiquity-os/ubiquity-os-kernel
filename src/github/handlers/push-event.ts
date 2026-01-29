import { Validator } from "@cfworker/json-schema";
import { ValueErrorType } from "@sinclair/typebox/value";
import type { ValueError } from "@sinclair/typebox/value";
import { YAMLException } from "js-yaml";
import YAML, { LineCounter, Node, YAMLError } from "yaml";
import { GitHubContext } from "../github-context.ts";
import { parsePluginIdentifier, PluginConfiguration } from "../types/plugin-configuration.ts";
import { getConfigPathCandidatesForEnvironment, getConfigurationFromRepo } from "../utils/config.ts";
import { getManifest } from "../utils/plugins.ts";

type ConfigValidationError = Pick<ValueError, "path" | "message" | "value" | "type">;

function encodePointerSegment(segment: string) {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

function decodePointerSegment(segment: string) {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

function pointerSegmentsToString(segments: (string | number)[]) {
  return segments.map((segment) => (typeof segment === "number" ? segment.toString() : encodePointerSegment(segment))).join("/");
}

function pointerStringToSegments(pointer: string): (string | number)[] {
  return pointer
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment, index) => {
      const decoded = decodePointerSegment(segment);
      if (index > 1 && /^\d+$/.test(decoded)) {
        return Number(decoded);
      }
      return decoded;
    });
}

function parseInstanceSegments(instanceLocation: string) {
  const pointer = instanceLocation.replace(/^#\/?/, "");
  if (!pointer.length) {
    return [] as (string | number)[];
  }
  return pointer
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      const decoded = decodePointerSegment(segment);
      return /^\d+$/.test(decoded) ? Number(decoded) : decoded;
    });
}

function constructErrorBody(
  errors: Iterable<ConfigValidationError> | (YAML.YAMLError | YAMLException | ConfigValidationError)[],
  rawData: string | null,
  repository: GitHubContext<"push">["payload"]["repository"],
  after: string,
  configPath: string
) {
  const body = [];
  if (errors) {
    for (const error of errors) {
      body.push("> [!CAUTION]\n");
      if (error instanceof YAMLError) {
        body.push(`> https://github.com/${repository.owner?.login}/${repository.name}/blob/${after}/${configPath}#L${error.linePos?.[0].line || 0}`);
      } else if (error instanceof YAMLException) {
        const mark = (error as YAMLException & { mark?: { line?: number } }).mark;
        body.push(`> https://github.com/${repository.owner?.login}/${repository.name}/blob/${after}/${configPath}#L${mark?.line ?? 0}`);
      } else if (rawData) {
        const lineCounter = new LineCounter();
        const doc = YAML.parseDocument(rawData, { lineCounter });
        // Convert the JSON pointer emitted by the validator into YAML path segments so we can locate the node.
        const pathSegments = pointerStringToSegments(error.path);
        if (error.type === ValueErrorType.ObjectRequiredProperty) {
          pathSegments.splice(pathSegments.length - 1, 1);
        }
        const node = doc.getIn(pathSegments, true) as Node;
        const linePosStart = lineCounter.linePos(node?.range?.[0] || 0);
        body.push(`> https://github.com/${repository.owner?.login}/${repository.name}/blob/${after}/${configPath}#L${linePosStart.line}`);
      }
      const message = [];
      if (error instanceof YAMLError || error instanceof YAMLException) {
        message.push(error.message);
      } else {
        message.push(`path: ${error.path}\n`);
        message.push(`value: ${JSON.stringify(error.value)}\n`);
        message.push(`message: ${error.message}`);
      }
      body.push(`\n> \`\`\`yml\n`);
      body.push(`> ${message.join("").replaceAll("\n", "\n> ")}`);
      body.push(`\n> \`\`\`\n\n`);
    }
  }
  return body;
}

async function createCommitComment(
  context: GitHubContext,
  { owner, repo, commitSha, userLogin }: { owner: string; repo: string; commitSha: string; userLogin?: string },
  body: string[]
) {
  const { octokit } = context;

  const comment = (
    await octokit.rest.repos.listCommentsForCommit({
      owner: owner,
      repo: repo,
      commit_sha: commitSha,
    })
  ).data
    .filter((o) => o.user?.type === "Bot")
    .pop();
  if (comment) {
    await octokit.rest.repos.updateCommitComment({
      owner: owner,
      repo: repo,
      commit_sha: commitSha,
      comment_id: comment.id,
      body: `${comment.body}\n${body.join("")}`,
    });
  } else {
    body.unshift(`@${userLogin} Configuration is invalid.\n`);
    await octokit.rest.repos.createCommitComment({
      owner: owner,
      repo: repo,
      commit_sha: commitSha,
      body: body.join(""),
    });
  }
}

async function checkPluginConfigurations(context: GitHubContext<"push">, config: PluginConfiguration, rawData: string | null) {
  const errors: (YAML.YAMLError | YAMLException | ConfigValidationError)[] = [];
  const doc = rawData ? YAML.parseDocument(rawData) : null;

  for (const [pluginKey, settings] of Object.entries(config.plugins)) {
    const pluginIdentifier = parsePluginIdentifier(pluginKey);
    const manifest = await getManifest(context, pluginIdentifier);
    const baseSegments: (string | number)[] = ["plugins", pluginKey];
    if (!manifest?.configuration) {
      errors.push({
        path: pointerSegmentsToString(baseSegments),
        message: "Failed to fetch the manifest configuration.",
        value: pluginKey,
        type: 0,
      });
      continue;
    }

    const validator = new Validator(manifest.configuration, "7", false);
    const result = validator.validate(settings?.with ?? {});

    if (!result.valid) {
      for (const error of result.errors) {
        const instanceSegments = parseInstanceSegments(error.instanceLocation);
        const pathSegments = [...baseSegments, "with", ...instanceSegments];
        const path = pointerSegmentsToString(pathSegments);
        const value = doc?.getIn(pathSegments);
        errors.push({
          path,
          message: error.error,
          value: JSON.stringify(value),
          type: 0,
        });
      }
    }
  }
  return errors;
}

export default async function handlePushEvent(context: GitHubContext<"push">) {
  const { payload } = context;
  const { repository, commits, after } = payload;
  const configPathCandidates = getConfigPathCandidatesForEnvironment(context.eventHandler.environment);
  let changedConfigPath: string | null = null;
  for (const commit of commits) {
    for (const path of configPathCandidates) {
      if (commit.modified?.includes(path) || commit.added?.includes(path)) {
        changedConfigPath = path;
        break;
      }
    }
    if (changedConfigPath) break;
  }

  if (!changedConfigPath || !repository.owner) {
    return;
  }

  context.logger.info({ repo: repository.full_name, after }, "Configuration file changed, will run configuration checks.");

  const { config, errors: configurationErrors, rawData } = await getConfigurationFromRepo(context, repository.name, repository.owner.login);
  const errors: (YAML.YAMLError | YAMLException | ConfigValidationError)[] = [];
  if (!configurationErrors && config) {
    errors.push(...(await checkPluginConfigurations(context, config, rawData)));
  } else if (configurationErrors) {
    errors.push(...configurationErrors);
  }
  try {
    if (errors.length) {
      const body = [];
      body.push(...constructErrorBody(errors, rawData, repository, after, changedConfigPath));
      await createCommitComment(
        context,
        {
          owner: repository.owner.login,
          repo: repository.name,
          commitSha: after,
          userLogin: payload.sender?.login,
        },
        body
      );
    }
  } catch (error) {
    context.logger.error({ error }, "handlePushEventError");
  }
}
