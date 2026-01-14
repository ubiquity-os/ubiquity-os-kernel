@ubiquity-os/ubiquity-os-kernel

The kernel is designed to:

- Interface with plugins (GitHub Actions) for longer-running processes.
- Run on Deno Deploy.

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

- Set `SUPABASE_URL` and `SUPABASE_ANON_KEY`.

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
   - `APP_WEBHOOK_SECRET`
   - `APP_ID`
   - `APP_PRIVATE_KEY`

   Optional: `DENO_ORG_NAME`, `DENO_PROJECT_NAME`, `ENVIRONMENT`, `UOS_AGENT_*`, `UOS_AGENT_MEMORY_*`, `UOS_AI_BASE_URL`, `SUPABASE_*`.

3. **Deploy:**

   - Push to `main` (or run the workflow manually) to deploy.

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
