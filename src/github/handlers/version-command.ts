import { GitHubContext } from "../github-context.ts";
import { getKernelCommit } from "../utils/kernel-metadata.ts";
import { getConfigFullPathForEnvironment } from "../utils/config.ts";

const VERSION_RESPONSE_MARKER = '"commentKind": "version-response"';

export async function postVersionCommand(context: GitHubContext<"issue_comment.created">) {
  const commitHash = await getKernelCommit();
  const environment = context.eventHandler.environment;
  const configPath = getConfigFullPathForEnvironment(environment);

  // Try to read version from package.json
  let kernelVersion = "unknown";
  try {
    const fs = await import("node:fs/promises");
    const pkg = await fs.readFile("package.json", "utf8");
    const { version } = JSON.parse(pkg);
    if (version) kernelVersion = version;
  } catch {
    // fallback to unknown
  }

  const body = [
    `| Field | Value |`,
    `|---|---|`,
    `| **Kernel Version** | \`${kernelVersion}\` |`,
    `| **Commit** | \`${commitHash}\` |`,
    `| **Environment** | \`${environment}\` |`,
    `| **Config** | \`${configPath}\` |`,
    ``,
    `###### UbiquityOS Kernel [${commitHash}](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/${commitHash})`,
  ].join("\n");

  const bodyWithMarker = appendVersionMarker(body);

  await context.octokit.rest.issues.createComment({
    body: bodyWithMarker,
    issue_number: context.payload.issue.number,
    owner: context.payload.repository.owner.login,
    repo: context.payload.repository.name,
  });
}

function appendVersionMarker(body: string): string {
  if (body.includes(VERSION_RESPONSE_MARKER)) return body;
  return `${body}\n\n<!-- ${VERSION_RESPONSE_MARKER} -->`;
}
