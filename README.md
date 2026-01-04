# @ubiquity-os/ubiquity-os-kernel

The kernel is designed to:

- Interface with plugins (GitHub Actions) for longer running processes.
- Run on Cloudflare Workers.

## Environment Variables

Minimum secrets for the kernel are `APP_PRIVATE_KEY` and `APP_WEBHOOK_SECRET` (plus the non-secret `APP_ID`).

- **`APP_PRIVATE_KEY`**
  Obtain a private key from your GitHub App settings and convert it to the Public-Key Cryptography Standards #8 (PKCS#8) format. A new private key in PEM format can be generated and downloaded from https://github.com/organizations/{your-organization-name}/settings/apps/{your-github-app-name}. Use the following command to perform PEM to PKCS#8 conversion and append the result to your `.env` file:

  ```sh
  echo "APP_PRIVATE_KEY=\"$(openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in YOUR_APP_PRIVATE_KEY.PEM | awk 'BEGIN{ORS="\\n"} 1')\"" >> .env
  ```

  **Note:** Replace `YOUR_APP_PRIVATE_KEY.PEM` with the path to your actual PEM file when running the command.

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

- Set `UOS_VECTOR_DB_URL` and `UOS_VECTOR_DB_KEY`, or
- Set `SUPABASE_URL` plus `SUPABASE_SERVICE_ROLE_KEY` (or `SUPABASE_ANON_KEY` for read-only access).
- `SUPABASE_PROJECT_ID` can be used to derive the URL when `SUPABASE_URL` is not set.

Conversation graph CLI (debug/preview):

```bash
GITHUB_TOKEN=... deno run -A --sloppy-imports scripts/conversation-graph.ts <github-url> --context
```

Useful flags: `--all`, `--no-semantic`, `--context-max-comments`, `--context-max-comment-chars`.

### Deploying to Cloudflare Workers

1. **Install Dependencies (for deploy tooling):**

   - Execute `npm install` (or your preferred Node package manager).

2. **Create a GitHub App:**

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

3. **Cloudflare Account Setup:**

   - If not done already, create a Cloudflare account.
   - Run `npx wrangler login` to log in.

4. **Manage Secrets:**

   - Add (env) secrets using `npx wrangler secret put <KEY> --env dev`.
   - For the private key, execute the following (replace `YOUR_APP_PRIVATE_KEY.PEM` with the actual PEM file path):

     ```sh
     echo $(openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in YOUR_APP_PRIVATE_KEY.PEM) | npx wrangler secret put APP_PRIVATE_KEY --env dev
     ```

5. **Deploy the Kernel:**

   - Execute `npm run deploy-dev` to deploy the kernel.

6. **Setup database (optional)**
   - You can set up your local database by going through [this repository](https://github.com/ubiquity-os/database) and following the instructions.

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
2. Cloudflare Workers (which are simple backend servers with a single API route)

How to run a "hello-world" plugin the Cloudflare way:

1. Run `deno task dev` to spin up the kernel
2. Run `bun plugin:hello-world` to spin up a local server for the "hello-world" plugin (requires Bun)
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
bun test
```
