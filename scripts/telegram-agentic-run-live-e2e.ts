import { Api, TelegramClient, utils } from "npm:telegram@2.26.22";
import { StringSession } from "npm:telegram@2.26.22/sessions/index.js";

const TELEGRAM_PLANNING_HEADER = "Planning mode.";
const TELEGRAM_READY_HEADER = "Plan ready.";

type TelegramSecretsFile = {
  botToken?: string;
  apiId?: number | string;
  apiHash?: string;
  userSession?: string;
};

type CliOptions = Readonly<{
  secretsFile: string;
  context: string | null;
  message: string;
  timeoutSeconds: number;
  approve: boolean;
  probeUnrelated: boolean;
  probeMessage: string;
  verifyButtonsCleared: boolean;
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
  if (opts.context) {
    console.log(`Context: ${opts.context}`);
  }
  console.log(`Request: ${opts.message}`);

  if (opts.context) {
    const contextCommand = `/topic ${opts.context}`;
    const contextSent = await client.sendMessage(botEntity, {
      message: contextCommand,
    });
    const contextReply = await waitForIncomingMessage({
      client,
      botEntity,
      afterId: getMessageId(contextSent),
      timeoutMs: opts.timeoutSeconds * 1000,
      match: (text) =>
        text.toLowerCase().includes("context set") || text.toLowerCase().includes("invalid github url") || text.toLowerCase().includes("github app"),
    });
    if (contextReply) {
      console.log("");
      console.log("Context response:");
      console.log(getMessageText(contextReply));
    }
  }

  // Best-effort cleanup in case a previous planning session is active.
  await client.sendMessage(botEntity, { message: "/cancel" });

  const sent = await client.sendMessage(botEntity, { message: opts.message });
  const sentId = getMessageId(sent);
  if (!sentId) throw new Error("Failed to resolve sent message id.");

  const planning = await waitForIncomingMessage({
    client,
    botEntity,
    afterId: sentId,
    timeoutMs: opts.timeoutSeconds * 1000,
    match: (text) => text.startsWith(TELEGRAM_PLANNING_HEADER) || text.startsWith(TELEGRAM_READY_HEADER),
  });
  if (!planning) {
    throw new Error(`Timed out waiting for a planning response within ${opts.timeoutSeconds}s.`);
  }

  await printKeyboard(planning);

  const planningText = getMessageText(planning);
  let readyMessage: unknown | null = null;
  if (planningText.startsWith(TELEGRAM_PLANNING_HEADER)) {
    if (opts.probeUnrelated) {
      const probeSent = await client.sendMessage(botEntity, {
        message: opts.probeMessage,
      });
      const probeReply = await waitForIncomingMessage({
        client,
        botEntity,
        afterId: getMessageId(probeSent),
        timeoutMs: opts.timeoutSeconds * 1000,
        match: (text) => Boolean(text.trim()),
      });
      if (!probeReply) {
        throw new Error(`Timed out waiting for probe reply within ${opts.timeoutSeconds}s.`);
      }

      console.log("");
      console.log("Probe response:");
      const probeText = getMessageText(probeReply);
      console.log(probeText);
      if (probeText.startsWith(TELEGRAM_PLANNING_HEADER) || probeText.startsWith(TELEGRAM_READY_HEADER)) {
        throw new Error("Probe message was treated as a plan update (expected a normal reply).");
      }
    }

    const didClickFinalize = await clickInlineButton({
      client,
      peer,
      message: planning,
      buttonText: "Finalize plan",
    });
    if (!didClickFinalize) {
      throw new Error("No Finalize plan button was found on the planning message.");
    }

    const ready = await waitForIncomingMessage({
      client,
      botEntity,
      afterId: getMessageId(planning),
      timeoutMs: opts.timeoutSeconds * 1000,
      match: (text) => text.startsWith(TELEGRAM_READY_HEADER),
    });
    if (!ready) {
      throw new Error(`Timed out waiting for '${TELEGRAM_READY_HEADER}' within ${opts.timeoutSeconds}s.`);
    }

    await printKeyboard(ready);
    readyMessage = ready;
    const readyId = getMessageId(ready);
    if (!readyId) {
      throw new Error(`Failed to resolve ${TELEGRAM_READY_HEADER} message id.`);
    }
  } else if (planningText.startsWith(TELEGRAM_READY_HEADER)) {
    readyMessage = planning;
  }

  if (!readyMessage) {
    throw new Error("Unexpected bot response: expected a planning or ready message.");
  }

  const readyId = getMessageId(readyMessage);
  if (!readyId) {
    throw new Error(`Failed to resolve ${TELEGRAM_READY_HEADER} message id.`);
  }

  if (opts.approve) {
    const didClickApprove = await clickInlineButton({
      client,
      peer,
      message: readyMessage,
      buttonText: "Approve",
    });
    if (!didClickApprove) {
      throw new Error("No Approve button was found on the ready message.");
    }

    if (opts.verifyButtonsCleared) {
      const didClearButtons = await waitForButtonsCleared({
        client,
        botEntity,
        messageId: readyId,
        timeoutMs: Math.max(5_000, Math.min(15_000, opts.timeoutSeconds * 1000)),
      });
      if (!didClearButtons) {
        throw new Error("Plan ready buttons did not clear after approval click.");
      }
      console.log("");
      console.log("Verified: Plan ready buttons cleared.");
    }

    const started = await waitForIncomingMessage({
      client,
      botEntity,
      afterId: readyId,
      timeoutMs: opts.timeoutSeconds * 1000,
      match: (text) => text.startsWith("Starting agent run.") || text.includes("I couldn't start the agent run") || text.includes("I still need answers"),
    });
    if (!started) {
      throw new Error(`Timed out waiting for agent dispatch acknowledgement within ${opts.timeoutSeconds}s.`);
    }

    console.log("");
    console.log("Agent dispatch response:");
    console.log(getMessageText(started));

    const runInfo = await waitForIncomingMessage({
      client,
      botEntity,
      afterId: getMessageId(started),
      timeoutMs: opts.timeoutSeconds * 1000,
      match: (text) => text.startsWith("Run logs:") || text.startsWith("Workflow:"),
    });
    if (runInfo) {
      console.log("");
      console.log("Run info:");
      console.log(getMessageText(runInfo));
    }
  }
} finally {
  await client.disconnect();
}

function parseArgs(args: string[]): CliOptions {
  const opts: {
    secretsFile?: string;
    context?: string;
    message?: string;
    timeoutSeconds?: number;
    approve?: boolean;
    probeUnrelated?: boolean;
    probeMessage?: string;
    verifyButtonsCleared?: boolean;
  } = {};

  for (let i = 0; i < args.length; i += 1) {
    const raw = args[i] ?? "";
    if (!raw) continue;

    if (raw === "--approve") {
      opts.approve = true;
      continue;
    } else if (raw === "--probe-unrelated") {
      opts.probeUnrelated = true;
      continue;
    } else if (raw === "--verify-buttons-cleared") {
      opts.verifyButtonsCleared = true;
      continue;
    }

    const [key, valueInline] = raw.startsWith("--") ? raw.split("=", 2) : [raw, undefined];
    const value = valueInline ?? args[i + 1];

    if (key === "--secrets-file") {
      if (valueInline === undefined) i += 1;
      opts.secretsFile = value;
    } else if (key === "--context") {
      if (valueInline === undefined) i += 1;
      opts.context = value;
    } else if (key === "--message") {
      if (valueInline === undefined) i += 1;
      opts.message = value;
    } else if (key === "--timeout-seconds") {
      if (valueInline === undefined) i += 1;
      const parsed = parsePositiveInt(value);
      if (parsed !== undefined) opts.timeoutSeconds = parsed;
    } else if (key === "--probe-message") {
      if (valueInline === undefined) i += 1;
      if (typeof value === "string" && value.trim()) {
        opts.probeMessage = value.trim();
      }
    }
  }

  return {
    secretsFile: opts.secretsFile?.trim() || ".secrets/telegram.json",
    context: typeof opts.context === "string" && opts.context.trim() ? opts.context.trim() : null,
    message:
      typeof opts.message === "string" && opts.message.trim()
        ? opts.message.trim()
        : "Start an agentic run: add a new capability that lets Telegram planning mode be finalized via inline buttons.",
    timeoutSeconds: opts.timeoutSeconds ?? 60,
    approve: opts.approve === true,
    probeUnrelated: opts.probeUnrelated === true,
    probeMessage: opts.probeMessage?.trim() || "Unrelated question: what is the capital of France?",
    verifyButtonsCleared: opts.verifyButtonsCleared === true,
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

  try {
    await params.client.invoke(
      new Api.messages.GetBotCallbackAnswer({
        peer: params.peer,
        msgId,
        data: match.data,
      })
    );
  } catch (error) {
    // The callback might still be delivered to the bot via webhook even if the user-side
    // callback answer times out. We'll let subsequent assertions (buttons cleared, follow-up
    // messages) determine whether it actually worked.
    const message = error instanceof Error ? error.message : String(error);
    if (message.toUpperCase().includes("TIMEOUT")) {
      console.warn(`Warning: callback answer timed out for '${params.buttonText}'. Continuing...`);
    } else {
      throw error;
    }
  }
  return true;
}

async function printKeyboard(message: unknown): Promise<void> {
  const text = getMessageText(message);
  console.log("");
  console.log("Bot message:");
  console.log(text.split("\n").slice(0, 12).join("\n"));
  console.log("");
  const buttons = extractInlineButtons(message);
  console.log("Inline buttons:");
  if (!buttons.length) {
    console.log("(none)");
    return;
  }
  for (const button of buttons) {
    console.log(`- ${button.text}${button.data ? "" : " (url)"}`);
  }
}

async function waitForButtonsCleared(params: { client: TelegramClient; botEntity: unknown; messageId: number; timeoutMs: number }): Promise<boolean> {
  const deadline = Date.now() + params.timeoutMs;
  const targetId = Math.trunc(params.messageId);

  while (Date.now() <= deadline) {
    const messages = await params.client.getMessages(params.botEntity as never, {
      limit: 20,
    });
    for (const message of messages) {
      if (getMessageId(message) !== targetId) continue;
      const buttons = extractInlineButtons(message);
      return buttons.length === 0;
    }
    await sleep(1_000);
  }
  return false;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
