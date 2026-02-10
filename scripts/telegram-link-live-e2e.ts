import { Api, TelegramClient, utils } from "npm:telegram@2.26.22";
import { StringSession } from "npm:telegram@2.26.22/sessions/index.js";

type TelegramSecretsFile = {
  botToken?: string;
  apiId?: number | string;
  apiHash?: string;
  userSession?: string;
};

type CliOptions = Readonly<{
  secretsFile: string;
  owner: string;
  timeoutSeconds: number;
  closeIssue: boolean;
  verifyConfig: boolean;
}>;

const opts = parseArgs(Deno.args);
const secrets = await loadTelegramSecrets(opts.secretsFile);

const botToken = secrets.botToken?.trim() ?? "";
if (!botToken) {
  throw new Error(`Missing botToken in ${opts.secretsFile}`);
}

const apiId = parsePositiveInt(secrets.apiId);
const apiHash = secrets.apiHash?.trim() ?? "";
const session = secrets.userSession?.trim() ?? "";
if (!apiId || !apiHash || !session) {
  throw new Error(`Missing Telegram MTProto config in ${opts.secretsFile}. Run: deno task telegram:user:login:write`);
}

const botUsername = await resolveBotUsername(botToken);
const client = new TelegramClient(new StringSession(session), apiId, apiHash, {
  connectionRetries: 3,
});

await client.connect();
try {
  const authorized = await client.isUserAuthorized();
  if (!authorized) {
    throw new Error("Telegram MTProto session is not authorized. Run: deno task telegram:user:login:write");
  }

  const botEntity = await client.getEntity(`@${botUsername}`);
  const peer = utils.getInputPeer(botEntity);

  console.log(`Bot: @${botUsername}`);
  console.log(`Owner: ${opts.owner}`);

  const statusSent = await client.sendMessage(botEntity, { message: "/status" });
  const status = await waitForIncomingMessage({
    client,
    botEntity,
    afterId: getMessageId(statusSent),
    timeoutMs: opts.timeoutSeconds * 1000,
    match: (text) =>
      text.toLowerCase().startsWith("status: linked") ||
      text.toLowerCase().startsWith("status: not linked") ||
      text.toLowerCase().startsWith("status: linking"),
  });
  if (!status) {
    throw new Error(`Timed out waiting for /status response within ${opts.timeoutSeconds}s.`);
  }

  const statusText = getMessageText(status);
  console.log("");
  console.log("Status:");
  console.log(statusText);

  const isAlreadyLinked = statusText.toLowerCase().startsWith("status: linked");
  if (isAlreadyLinked) {
    console.log("");
    console.log("Already linked; nothing to do.");
  } else {
    await printKeyboard(status);

    const statusLower = statusText.toLowerCase();
    let isCompleted = false;

    // If we're resuming an in-progress link, /status might not include the Start linking
    // button. Handle the pending states explicitly.
    if (statusLower.startsWith("status: linking")) {
      if (statusLower.includes("waiting for link issue close")) {
        const issueUrl = extractIssueUrl(statusText);
        if (!issueUrl) {
          throw new Error("Status indicates a pending issue close, but no Issue URL was found in the status message.");
        }
        console.log("");
        console.log(`Pending link issue: ${issueUrl}`);

        const parsedIssue = parseGitHubIssueUrl(issueUrl);
        if (!parsedIssue) {
          throw new Error(`Unexpected issue URL format: ${issueUrl}`);
        }

        if (opts.closeIssue) {
          await closeGitHubIssue({
            owner: parsedIssue.owner,
            repo: parsedIssue.repo,
            issueNumber: parsedIssue.issueNumber,
          });
          console.log("");
          console.log(`Closed ${parsedIssue.owner}/${parsedIssue.repo}#${parsedIssue.issueNumber}`);
        } else {
          console.log("");
          console.log("Skipping auto-close (--no-close). Close the issue manually.");
        }

        const confirmation = await waitForIncomingMessage({
          client,
          botEntity,
          afterId: getMessageId(status),
          timeoutMs: opts.timeoutSeconds * 1000,
          match: (text) => text.toLowerCase().startsWith("linked to") && text.toLowerCase().includes("you're all set"),
        });
        if (!confirmation) {
          throw new Error(`Timed out waiting for link confirmation within ${opts.timeoutSeconds}s.`);
        }

        console.log("");
        console.log("Confirmation:");
        console.log(getMessageText(confirmation));

        if (opts.verifyConfig) {
          const isConfigOk = await checkOrgConfigExists({ owner: opts.owner });
          console.log("");
          console.log(isConfigOk ? "Verified .ubiquity-os config exists." : "Warning: .ubiquity-os config was not found (or could not be checked).");
        }
        isCompleted = true;
      }

      if (!isCompleted) {
        if (!statusLower.includes("waiting for github owner")) {
          throw new Error("Unrecognized linking state from /status output.");
        }

        console.log("");
        console.log("Continuing pending link: sending owner...");
      }
    } else {
      const didClickStart = await clickInlineButton({
        client,
        peer,
        message: status,
        buttonText: "Start linking",
      });
      if (!didClickStart) {
        throw new Error("No Start linking button was found. Make sure you're running this in a DM with the bot.");
      }

      const ownerPrompt = await waitForIncomingMessage({
        client,
        botEntity,
        afterId: getMessageId(status),
        timeoutMs: opts.timeoutSeconds * 1000,
        match: (text) => text.toLowerCase().includes("send the github owner"),
      });
      if (!ownerPrompt) {
        throw new Error(`Timed out waiting for owner prompt within ${opts.timeoutSeconds}s.`);
      }

      console.log("");
      console.log("Owner prompt:");
      console.log(getMessageText(ownerPrompt));
    }

    if (!isCompleted) {
      const ownerSent = await client.sendMessage(botEntity, {
        message: opts.owner,
      });
      const issueMessage = await waitForIncomingMessage({
        client,
        botEntity,
        afterId: getMessageId(ownerSent),
        timeoutMs: opts.timeoutSeconds * 1000,
        match: (text) => text.toLowerCase().includes("link issue created") && text.toLowerCase().includes("close the issue"),
      });
      if (!issueMessage) {
        throw new Error(`Timed out waiting for link issue message within ${opts.timeoutSeconds}s.`);
      }

      const issueText = getMessageText(issueMessage);
      console.log("");
      console.log("Link issue message:");
      console.log(issueText);

      const issueUrl = extractIssueUrl(issueText);
      if (!issueUrl) {
        throw new Error("Failed to extract link issue URL from the bot message.");
      }
      console.log("");
      console.log(`Link issue: ${issueUrl}`);

      const parsedIssue = parseGitHubIssueUrl(issueUrl);
      if (!parsedIssue) {
        throw new Error(`Unexpected issue URL format: ${issueUrl}`);
      }
      if (parsedIssue.owner.toLowerCase() !== opts.owner.toLowerCase()) {
        console.log("");
        console.log(`Warning: issue owner ${parsedIssue.owner} did not match requested owner ${opts.owner}. Continuing...`);
      }

      if (opts.closeIssue) {
        await closeGitHubIssue({
          owner: parsedIssue.owner,
          repo: parsedIssue.repo,
          issueNumber: parsedIssue.issueNumber,
        });
        console.log("");
        console.log(`Closed ${parsedIssue.owner}/${parsedIssue.repo}#${parsedIssue.issueNumber}`);
      } else {
        console.log("");
        console.log("Skipping auto-close (--no-close). Close the issue manually.");
      }

      const confirmation = await waitForIncomingMessage({
        client,
        botEntity,
        afterId: getMessageId(issueMessage),
        timeoutMs: opts.timeoutSeconds * 1000,
        match: (text) => text.toLowerCase().startsWith("linked to") && text.toLowerCase().includes("you're all set"),
      });
      if (!confirmation) {
        throw new Error(`Timed out waiting for link confirmation within ${opts.timeoutSeconds}s.`);
      }

      console.log("");
      console.log("Confirmation:");
      console.log(getMessageText(confirmation));

      if (opts.verifyConfig) {
        const isConfigOk = await checkOrgConfigExists({ owner: opts.owner });
        console.log("");
        console.log(isConfigOk ? "Verified .ubiquity-os config exists." : "Warning: .ubiquity-os config was not found (or could not be checked).");
      }
    }
  }
} finally {
  await client.disconnect();
}

function parseArgs(args: string[]): CliOptions {
  const opts: {
    secretsFile?: string;
    owner?: string;
    timeoutSeconds?: number;
    closeIssue?: boolean;
    verifyConfig?: boolean;
  } = {};

  for (let i = 0; i < args.length; i += 1) {
    const raw = args[i] ?? "";
    if (!raw) continue;

    if (raw === "--no-close") {
      opts.closeIssue = false;
      continue;
    } else if (raw === "--no-verify-config") {
      opts.verifyConfig = false;
      continue;
    }

    const [key, valueInline] = raw.startsWith("--") ? raw.split("=", 2) : [raw, undefined];
    const value = valueInline ?? args[i + 1];

    if (key === "--secrets-file") {
      if (valueInline === undefined) i += 1;
      opts.secretsFile = value;
    } else if (key === "--owner") {
      if (valueInline === undefined) i += 1;
      opts.owner = value;
    } else if (key === "--timeout-seconds") {
      if (valueInline === undefined) i += 1;
      const parsed = parsePositiveInt(value);
      if (parsed !== undefined) opts.timeoutSeconds = parsed;
    }
  }

  const owner = (opts.owner ?? "").trim();
  if (!owner) {
    throw new Error("Missing --owner (GitHub username or org).");
  }

  return {
    secretsFile: opts.secretsFile?.trim() || ".secrets/telegram.json",
    owner,
    timeoutSeconds: opts.timeoutSeconds ?? 90,
    closeIssue: opts.closeIssue !== false,
    verifyConfig: opts.verifyConfig !== false,
  };
}

async function loadTelegramSecrets(path: string): Promise<TelegramSecretsFile> {
  const raw = await Deno.readTextFile(path);
  const trimmed = raw.trim();
  if (!trimmed) return {};
  const parsed = JSON.parse(trimmed) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return parsed as TelegramSecretsFile;
}

function parsePositiveInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const normalized = Math.trunc(value);
    return normalized > 0 ? normalized : undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return undefined;
    const normalized = Math.trunc(parsed);
    return normalized > 0 ? normalized : undefined;
  }
  return undefined;
}

async function resolveBotUsername(botToken: string): Promise<string> {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/getMe`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Failed to resolve bot username (status ${response.status}). ${detail}`);
  }
  const data = (await response.json().catch(() => null)) as {
    result?: { username?: unknown };
  } | null;
  const username = data?.result?.username;
  if (typeof username !== "string" || !username.trim()) {
    throw new Error("Bot username missing from getMe response.");
  }
  return username.trim();
}

function getMessageId(message: unknown): number {
  const id = (message as { id?: unknown } | null)?.id;
  return typeof id === "number" && Number.isFinite(id) ? Math.trunc(id) : 0;
}

function getMessageText(message: unknown): string {
  const text = (message as { message?: unknown } | null)?.message;
  return typeof text === "string" ? text.trim() : "";
}

async function waitForIncomingMessage(params: {
  client: TelegramClient;
  botEntity: unknown;
  afterId: number;
  timeoutMs: number;
  match: (text: string) => boolean;
}): Promise<unknown | null> {
  const deadline = Date.now() + params.timeoutMs;

  while (Date.now() <= deadline) {
    const messages = await params.client.getMessages(params.botEntity as never, {
      limit: 10,
    });
    for (const message of messages) {
      const id = getMessageId(message);
      if (!id || id <= params.afterId) continue;
      const out = (message as { out?: unknown } | null)?.out;
      if (out === true) continue;
      const text = getMessageText(message);
      if (!text) continue;
      if (params.match(text)) return message;
    }

    await sleep(1_000);
  }

  return null;
}

function extractInlineButtons(message: unknown): Array<{
  text: string;
  data: Uint8Array | null;
}> {
  const markup = (message as { replyMarkup?: unknown } | null)?.replyMarkup;
  if (!(markup instanceof Api.ReplyInlineMarkup)) return [];

  const buttons: Array<{ text: string; data: Uint8Array | null }> = [];
  for (const row of markup.rows) {
    for (const button of row.buttons) {
      if (button instanceof Api.KeyboardButtonCallback) {
        const data = button.data instanceof Uint8Array ? button.data : null;
        buttons.push({ text: button.text, data });
      } else if (button instanceof Api.KeyboardButtonUrl) {
        buttons.push({ text: button.text, data: null });
      }
    }
  }
  return buttons;
}

async function clickInlineButton(params: { client: TelegramClient; peer: Api.TypeInputPeer; message: unknown; buttonText: string }): Promise<boolean> {
  const msgId = getMessageId(params.message);
  if (!msgId) return false;

  const desired = params.buttonText.trim().toLowerCase();
  if (!desired) return false;

  const buttons = extractInlineButtons(params.message);
  const match = buttons.find((button) => button.text.trim().toLowerCase() === desired);
  if (!match?.data) return false;

  await params.client.invoke(
    new Api.messages.GetBotCallbackAnswer({
      peer: params.peer,
      msgId,
      data: match.data,
    })
  );
  return true;
}

async function printKeyboard(message: unknown): Promise<void> {
  const buttons = extractInlineButtons(message);
  console.log("");
  console.log("Inline buttons:");
  if (!buttons.length) {
    console.log("(none)");
    return;
  }
  for (const button of buttons) {
    console.log(`- ${button.text}${button.data ? "" : " (url)"}`);
  }
}

function extractIssueUrl(text: string): string | null {
  const match = text.match(/(?:^|\n)Issue:\s*(https:\/\/github\.com\/[^\s]+)\s*(?:$|\n)/i);
  return match?.[1]?.trim() || null;
}

function parseGitHubIssueUrl(url: string): {
  owner: string;
  repo: string;
  issueNumber: number;
} | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.toLowerCase() !== "github.com") return null;
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length < 4) return null;
    const [owner, repo, kind, number] = parts;
    if (kind !== "issues") return null;
    const issueNumber = Number.parseInt(String(number), 10);
    if (!Number.isFinite(issueNumber) || issueNumber <= 0) return null;
    return { owner, repo, issueNumber };
  } catch {
    return null;
  }
}

async function closeGitHubIssue(params: { owner: string; repo: string; issueNumber: number }): Promise<void> {
  const token = readGitHubToken();
  if (!token) {
    throw new Error("Missing GitHub token in env (GITHUB_TOKEN, GH_TOKEN, or GITHUB_TOKEN_SIMULANT) required to auto-close the link issue.");
  }

  // REST `PATCH /issues/{number}` has been intermittently returning 500 for this repo.
  // Use GraphQL's closeIssue mutation instead (same permission model, more reliable).
  const headers = {
    "content-type": "application/json",
    accept: "application/vnd.github+json",
    authorization: `bearer ${token}`,
    "user-agent": "ubiquity-os-kernel-telegram-link-e2e",
  };

  const query = [
    "query($owner:String!, $repo:String!, $number:Int!) {",
    "  repository(owner: $owner, name: $repo) {",
    "    issue(number: $number) { id }",
    "  }",
    "}",
  ].join("\n");

  const idResponse = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers,
    body: JSON.stringify({
      query,
      variables: {
        owner: params.owner,
        repo: params.repo,
        number: params.issueNumber,
      },
    }),
  });
  const idPayload = (await idResponse.json().catch(() => null)) as {
    data?: { repository?: { issue?: { id?: string } } };
    errors?: Array<{ message?: string }>;
  } | null;
  const issueId = idPayload?.data?.repository?.issue?.id ?? "";
  if (!issueId) {
    const detail =
      idPayload?.errors
        ?.map((e) => e.message)
        .filter(Boolean)
        .join(" ") || "";
    throw new Error(`Failed to resolve issue id for ${params.owner}/${params.repo}#${params.issueNumber}. ${detail}`);
  }

  const mutation = ["mutation($issueId:ID!) {", "  closeIssue(input: { issueId: $issueId }) {", "    issue { number state }", "  }", "}"].join("\n");

  const closeResponse = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers,
    body: JSON.stringify({
      query: mutation,
      variables: { issueId },
    }),
  });
  const closePayload = (await closeResponse.json().catch(() => null)) as {
    data?: { closeIssue?: { issue?: { state?: string } } };
    errors?: Array<{ message?: string }>;
  } | null;
  const closeErrors =
    closePayload?.errors
      ?.map((e) => e.message)
      .filter(Boolean)
      .join(" ") || "";
  if (!closeResponse.ok || closeErrors) {
    throw new Error(`Failed to close issue via GraphQL (status ${closeResponse.status}). ${closeErrors || "Unexpected response."}`);
  }
}

async function checkOrgConfigExists(params: { owner: string }): Promise<boolean> {
  const token = readGitHubToken();
  if (!token) return false;

  const path = encodeURIComponent(".github/.ubiquity-os.config.yml");
  const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(params.owner)}/.ubiquity-os/contents/${path}`, {
    method: "GET",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `token ${token}`,
      "user-agent": "ubiquity-os-kernel-telegram-link-e2e",
    },
  });
  return response.ok;
}

function readGitHubToken(): string {
  return (Deno.env.get("GITHUB_TOKEN") ?? Deno.env.get("GH_TOKEN") ?? Deno.env.get("GITHUB_TOKEN_SIMULANT") ?? "").trim();
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
