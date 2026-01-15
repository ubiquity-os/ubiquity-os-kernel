@ubiquity-os/ubiquity-os-kernel

The kernel is designed to:

- Interface with plugins (GitHub Actions) for longer-running processes.
- Run on Deno Deploy.

## Environment Variables

Minimum secrets for the kernel live in `UOS_GITHUB` (JSON):

```json
{"appId":"GITHUB_APP_ID","webhookSecret":"GITHUB_WEBHOOK_SECRET","privateKey":"GITHUB_APP_PRIVATE_KEY_PEM"}
```

`privateKey` must be PKCS#8. If your GitHub App key is PEM, convert it:

```sh
openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in YOUR_APP_PRIVATE_KEY.PEM
```

When storing in JSON, keep the PEM as a single string (the loader accepts `\n` escapes).

Helper (writes or updates `.secrets/github.json`):

```bash
deno task secrets:github -- --pem=path/to/key.pem --app-id=123 --webhook-secret=secret
```

If `.secrets/github.json` already exists, you can update only the private key:

```bash
deno task secrets:github -- --pem=path/to/key.pem
```

Optional JSON configs:

- `UOS_AI`: `{"baseUrl":"https://ai-ubq-fi.deno.dev","token":"YOUR_AI_TOKEN"}`
- `UOS_AGENT`: `{"owner":"ubiquity-os","repo":"ubiquity-os-kernel","workflow":"agent.yml","ref":"main"}`
- `UOS_AGENT_MEMORY`: `{"url":"https://example.com/agent-memory","key":"BASE64_32_BYTE_KEY"}`
- `UOS_DIAGNOSTICS`: `{"token":"YOUR_DIAGNOSTICS_TOKEN"}`
- `UOS_SUPABASE`: `{"url":"https://your-project.supabase.co","anonKey":"YOUR_SUPABASE_ANON_KEY"}`
- `UOS_KERNEL`: `{"refreshIntervalSeconds":3600}`

For local development, expose the kernel with a public HTTPS tunnel (ngrok or a self-hosted reverse proxy) and point the GitHub App webhook directly at that public URL. The kernel derives its refresh endpoint from the incoming webhook host.

### Quick Start

```bash
git clone --recurse-submodules https://github.com/ubiquity-os/ubiquity-os-kernel
cd ubiquity-os-kernel
deno task dev
```

`deno task dev` pulls npm dependencies into the Deno cache on first run; no `bun install` or `node_modules` are required to run the kernel locally.

For local convenience, `deno task dev:easy` (or `deno task dev:serve:easy`) runs with `-A` permissions and loads `.env`. Use it only for trusted local development; `deno task dev`/`deno task dev:serve` keep explicit permissions.

Marketplace plugins under `lib/plugins/` are pinned submodules. Refer to each plugin repo for its own security review and docs (for example, `command-config`: https://github.com/ubiquity-os-marketplace/command-config).

## Conversation Graph and Agent Context

The kernel builds a conversation graph for each issue/PR event so the agent can answer with context that spans linked threads.

What the graph contains:

- The root issue or pull request.
- Linked threads from timeline cross-references and outbound GitHub URLs in bodies and comments.
- Optional semantic matches from the vector DB (issues, PRs, issue comments, review comments).

Agent context selection:

- `buildConversationContext` collects the graph plus recent comments and runs a lightweight selector using the user query.
- The root node is always included; comment bodies are trimmed to 256 characters by default, with full URLs preserved for follow-up fetches.
- Semantic matches are included when the vector DB is configured.

Vector DB configuration (Supabase):

- Set `UOS_SUPABASE` with `{ "url": "...", "anonKey": "..." }`.

Conversation graph CLI (debug/preview):

```bash
GITHUB_TOKEN=... deno run -A --sloppy-imports scripts/conversation-graph.ts <github-url> --context
```

Useful flags: `--all`, `--no-semantic`, `--context-max-comments`, `--context-max-comment-chars`.

### Deploying to Deno Deploy

Deployments are handled by GitHub Actions via `.github/workflows/deno-deploy.yml`.

1. **Create a GitHub App:**

   - Generate a GitHub App and configure its settings.
   - Navigate to app settings and click `Permissions & events`.
   - Ensure the app is subscribed to all events with the following permissions:

     Repository permissions:

     - Actions: Read & Write
     - Contents: Read & Write
     - Issues: Read & Write
     - Pull Requests: Read & Write

     Organization permissions:

     - Members: Read only

2. **Set repository secrets (required):**

   - `DENO_DEPLOY_TOKEN`
   - `UOS_GITHUB`

   Optional: `DENO_ORG_NAME`, `DENO_PROJECT_NAME`, `ENVIRONMENT`, `UOS_AGENT`, `UOS_AI`, `UOS_AGENT_MEMORY`, `UOS_DIAGNOSTICS`, `UOS_SUPABASE`, `UOS_KERNEL`, `UOS_GOOGLE_DRIVE`, `UOS_TELEGRAM`, `UOS_X`.

3. **Deploy:**

   - Push to `main` (or run the workflow manually) to deploy.

### Telegram Ingress (Optional)

Configure the kernel to accept Telegram webhooks at `/telegram`:

- `UOS_TELEGRAM` (JSON; required to enable ingress)

Example:

```json
{"mode":"github","botToken":"...","webhookSecret":"...","owner":"ubiquity-os-marketplace","repo":"ubiquity-os-marketplace","issueNumber":1,"installationId":123}
```

Fields:

- `mode` (optional; `github` or `shim`, defaults to `github`)
- `shim` mode skips GitHub routing and only supports built-in Telegram commands.
- `botToken` (required)
- `issueNumber` (required in `github` mode; the GitHub issue used for routing/context)
- `webhookSecret` (optional, validates `x-telegram-bot-api-secret-token`)
- `owner` / `repo` (optional, defaults to `ubiquity-os-marketplace`)
- `installationId` (optional override)

### Google Drive Ingress (Optional)

Configure the kernel to accept Google Drive webhooks at `/google/drive`:

- `UOS_GOOGLE_DRIVE` (JSON; required to enable ingress)

Example:

```json
{"webhookSecret":"..."}
```

### X Ingress (Optional)

Configure the kernel to accept X webhooks at `/x`:

- `UOS_X` (JSON; required to enable ingress)

Example:

```json
{"webhookSecret":"..."}
```

### Local Ingress Config Helper (Optional)

For local dev, you can keep ingress JSON files on disk and let a helper task load them into env:

```bash
mkdir -p .secrets
deno task dev:ingress
```

Create any of `.secrets/github.json`, `.secrets/ai.json`, `.secrets/agent.json`, `.secrets/agent-memory.json`, `.secrets/diagnostics.json`, `.secrets/supabase.json`, `.secrets/kernel.json`, `.secrets/telegram.json`, `.secrets/google-drive.json`, `.secrets/x.json` and the task will load whichever exist. Example templates live under `.secrets/*.example.json` (copy them to `.secrets/*.json`). Use `deno task dev:ingress:easy` for `-A` local runs. You can override paths:

```bash
deno task dev:ingress -- --github=secrets/github.json --ai=secrets/ai.json --telegram=secrets/telegram.json --x=secrets/x.json
```

### Plugin-Kernel Input/Output Interface

#### Input

Inputs are received within the workflow, triggered by the `workflow_dispatch` event. The plugin is designed to handle the following inputs:

```typescript
interface PluginInput {
  stateId: string; // Identifier used to trace a plugin invocation
  eventName: string; // The complete name of the event (e.g., `issue_comment.created`)
  eventPayload: any; // The payload associated with the event
  settings: string; // A string containing JSON with settings specific to your plugin
  authToken: string; // A JWT token for accessing GitHub's API to the repository where the event occurred
  ref: string; // A reference (branch, tag, commit SHA) indicating the version of the plugin to be utilized
}
```

Example usage:

```typescript
const input: PluginInput = {
  stateId: "abc123",
  eventName: "issue_comment.created",
  eventPayload: {
    /* ... */
  },
  settings: '{ "key": "value" }',
  authToken: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  ref: "refs/heads/main",
};
```

## Plugin Quick Start

The kernel supports 2 types of plugins:

1. GitHub actions ([wiki](https://github.com/ubiquity-os/ubiquity-os-kernel/wiki/How-it-works))
2. HTTP plugins (simple backend servers with a single API route)

How to run a "hello-world" plugin locally:

1. Run `deno task dev` to spin up the kernel
2. Run `bun run plugin:hello-world` to spin up a local server for the "hello-world" plugin (requires Bun)
3. Update the bot's config file in the repository where you use the bot (`OWNER/REPOSITORY/.github/.ubiquity-os.config.yml`):
   ```yml
   plugins:
   http://127.0.0.1:9090:
     skipBotEvents: true
     runsOn:
       - issue_comment.created
     with:
       response: world
   ```
4. Post a `/hello` comment in any issue
5. The bot should respond with the `world` message ([example](https://github.com/rndquu-org/test-repo/issues/54#issuecomment-2149313139))

How it works:

1. When you post the `/hello` command the kernel receives the `issue_comment.created` event
2. The kernel matches the `/hello` command to the plugin that should be executed (i.e. the API method that should be called)
3. The kernel passes GitHub event payload, bot's access token and plugin settings (from `.ubiquity-os.config.yml`) to the plugin endpoint
4. The plugin performs all the required actions and returns the result

## Hello world plugin tutorial

A screencast tutorial on how to set up and run a hello world plugin is available at [wiki](https://github.com/ubiquity-os/ubiquity-os-kernel/wiki/Hello-world-plugin-onboarding-tutorial).

## Testing

### Jest

To start Jest tests, run

```shell
bun run jest:test
```
