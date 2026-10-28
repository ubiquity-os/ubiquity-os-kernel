@ubiquity-os/ubiquity-os-kernel

The kernel is designed to:

- Interface with plugins (GitHub Actions) for longer-running processes.
- Run on Cloudflare Workers behind an event-driven gate.

## Environment Variables

Minimum secrets for the kernel are `APP_PRIVATE_KEY` and `APP_WEBHOOK_SECRET` (plus the non-secret `APP_ID`).

- **`APP_PRIVATE_KEY`**
  Obtain a private key from your GitHub App settings and convert it to the Public-Key Cryptography Standards #8 (PKCS#8) format. A new private key in PEM format can be generated and downloaded from [https://github.com/organizations/{your-organization-name}/settings/apps/{your-github-app-name}](https://github.com/organizations/{your-organization-name}/settings/apps/{your-github-app-name}). Use the following command to perform PEM to PKCS#8 conversion and append the result to your `.env` file:

  ```sh
  echo "APP_PRIVATE_KEY=\"$(openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in YOUR_APP_PRIVATE_KEY.PEM | awk 'BEGIN{ORS="\\n"} 1')\"" >> .env
  ```

  **Note:** Replace `YOUR_APP_PRIVATE_KEY.PEM` with the path to your actual PEM file when running the command. On Windows, run the command via WSL or Git Bash.

- **`APP_WEBHOOK_SECRET`**
  Set this value in both your GitHub App settings and here.

- **`APP_ID`**
  Retrieve this from your GitHub App settings.

For local development, expose the kernel with a public HTTPS tunnel (ngrok or a self-hosted reverse proxy) and point the GitHub App webhook directly at that public URL. The kernel derives its refresh endpoint from the incoming webhook host unless `UOS_KERNEL_BASE_URL` (or `UOS_KERNEL_TRUSTED_HOSTS`) is set.

### Quick Start

```bash
git clone --recurse-submodules https://github.com/ubiquity-os/ubiquity-os-kernel
cd ubiquity-os-kernel
bun install
bun run dev
```

`bun run dev` starts the Worker locally through Wrangler. The Deno tasks remain available for the existing tests, typecheck, lint, and formatting checks.

Marketplace plugins under `lib/plugins/` are pinned submodules. Refer to each plugin repo for its own security review and docs (for example, [`command-config`](https://github.com/ubiquity-os-marketplace/command-config)).

We keep the `lib/plugins/hello-world-plugin` example in this repo to make local testing and CI smoke checks easy; production plugins should live in their own repositories.

### Dependency pins

`package.json` and `bun.lock` own the Worker runtime dependencies. The Deno import map in `deno.json` remains for the existing test and tooling commands; keep both dependency sets aligned when upgrading shared packages.

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

- Set `SUPABASE_URL` and `SUPABASE_ANON_KEY`.

Conversation graph CLI (debug/preview):

```bash
GITHUB_TOKEN=... deno run -A --sloppy-imports scripts/conversation-graph.ts <github-url> --context
```

Useful flags: `--all`, `--no-semantic`, `--context-max-comments`, `--context-max-comment-chars`.

### Deploying to Cloudflare Workers

Deployments are handled by `.github/workflows/workers-deploy.yml`.

The stack has two Workers in the `Ubiquity DAO Workers` account:

- `ubiquity-os-kernel` and `ubiquity-os-kernel-development`: the kernel.
- `ubiquity-os-kernel-gate` and `ubiquity-os-kernel-gate-development`: the public GitHub webhook gate.

The gate verifies GitHub signatures, caches repository config state in Workers KV, and calls the kernel through a service binding. Confirmed unconfigured repositories return `204` until a config-changing push or the existing 24-hour status expiry. Unknown/nonconfigured traffic is counted per account and organization config version by a native limiter at 30 requests per minute; exceeding it starts a 900-second cooldown that doubles on later bursts up to 30 days. Absent probes independently back off from 30 seconds to 30 days using a separate durable key, so an immediate burst avoids same-key PUT throttling. Active cooldowns do not extend on each denial. Missing repository lookups are cached as unknown for 30 seconds without suppressing eligible kernel probes. A cold owner lookup costs two KV reads; each transition writes one key, and recovery deletes each of the two keys once. Config-changing pushes bypass and reset account cooldowns, organization config pushes create a fresh limiter bucket, and configured traffic remains exempt. A missing or failing limiter returns retriable `503` for unknown/nonconfigured events without adding penalties. The limiter is approximate and per Cloudflare location; KV is eventually consistent. There is no cron and durable writes occur only on transitions or config-changing pushes.

Production and development endpoints:

- Production gate: `https://ubiquity-os-kernel-gate.ubiquity.workers.dev/`
- Development gate: `https://ubiquity-os-kernel-gate-development.ubiquity.workers.dev/`

Set the GitHub App webhook URL to the gate URL for the target environment.

Required repository secrets:

- `CLOUDFLARE_API_TOKEN`
- `APP_WEBHOOK_SECRET`
- `APP_ID`
- `APP_PRIVATE_KEY`

Optional: `UOS_AI_TOKEN`, `UOS_DIAGNOSTICS_TOKEN`, `UOS_AGENT_MEMORY_*`, `SUPABASE_*`.

Pushing to `development` deploys both development Workers. Pushing to `main` deploys both production Workers.

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

1. Run `bun run dev` to spin up the kernel
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

CI runs the Deno test workflow (`.github/workflows/testing.yml`) against `tests/`. The kernel runtime itself is deployed on Cloudflare Workers.

### Jest

To start Jest tests, run

```shell
bun run jest:test
```
