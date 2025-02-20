# @ubiquity-os/ubiquity-os-kernel

The kernel is designed to:

- Interface with plugins (GitHub Actions) for longer running processes.
- Run on Cloudflare Workers.

## Environment Variables

- **`APP_PRIVATE_KEY`**
  Obtain a private key from your GitHub App settings and convert it to the Public-Key Cryptography Standards #8 (PKCS#8) format. A new private key in PEM format can be generated and downloaded from https://github.com/organizations/{your-organization-name}/settings/apps/{your-github-app-name}. Use the following command to perform PEM to PKCS#8 conversion and append the result to your `.dev.vars` file:

  ```sh
  echo "APP_PRIVATE_KEY=\"$(openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in YOUR_APP_PRIVATE_KEY.PEM | awk 'BEGIN{ORS="\\n"} 1')\"" >> .dev.vars
  ```

  **Note:** Replace `YOUR_APP_PRIVATE_KEY.PEM` with the path to your actual PEM file when running the command.

- **`APP_WEBHOOK_SECRET`**
  Set this value in both your GitHub App settings and here.

- **`APP_ID`**
  Retrieve this from your GitHub App settings.

- **`WEBHOOK_PROXY_URL` (only for development)**
  Obtain a webhook URL at [smee.io](https://smee.io/) and set it in your GitHub App settings.

### Quick Start

```bash
git clone https://github.com/ubiquity-os/ubiquity-os-kernel
cd ubiquity-os-kernel
bun install
bun dev
```

### Deploying to Cloudflare Workers

1. **Install Dependencies:**

   - Execute `bun install` to install the required dependencies.

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

4. **Create a KV Namespace:**

   - Generate a KV namespace using `npx wrangler kv:namespace create PLUGIN_CHAIN_STATE`.
   - Copy the generated ID and paste it under `[env.dev]` in `wrangler.toml`.

5. **Manage Secrets:**

   - Add (env) secrets using `npx wrangler secret put <KEY> --env dev`.
   - For the private key, execute the following (replace `YOUR_APP_PRIVATE_KEY.PEM` with the actual PEM file path):

     ```sh
     echo $(openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in YOUR_APP_PRIVATE_KEY.PEM) | npx wrangler secret put APP_PRIVATE_KEY --env dev
     ```

6. **Deploy the Kernel:**

   - Execute `bun run deploy-dev` to deploy the kernel.

7. **Setup database (optional)**
   - You can set up your local database by going through [this repository](https://github.com/ubiquity-os/database) and following the instructions.

### Plugin-Kernel Input/Output Interface

#### Input

Inputs are received within the workflow, triggered by the `workflow_dispatch` event. The plugin is designed to handle the following inputs:

```typescript
interface PluginInput {
  stateId: string; // An identifier used to track the state of plugin chain execution in Cloudflare KV
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

#### Output

Data is returned using the `repository_dispatch` event on the plugin's repository, and the output is structured within the `client_payload`.

The `event_type` must be set to `return-data-to-ubiquity-os-kernel`.

```typescript
interface PluginOutput {
  state_id: string; // The state ID passed in the inputs must be included here
  output: string; // A string containing JSON with custom output, defined by the plugin itself
}
```

Example usage:

```typescript
const output: PluginOutput = {
  state_id: "abc123",
  output: '{ "result": "success", "message": "Plugin executed successfully" }',
};
```

## Plugin Quick Start

The kernel supports 2 types of plugins:

1. GitHub actions ([wiki](https://github.com/ubiquity-os/ubiquity-os-kernel/wiki/How-it-works))
2. Cloudflare Workers (which are simple backend servers with a single API route)

How to run a "hello-world" plugin the Cloudflare way:

1. Run `bun dev` to spin up the kernel
2. Run `bun plugin:hello-world` to spin up a local server for the "hello-world" plugin
3. Update the bot's config file in the repository where you use the bot (`OWNER/REPOSITORY/.github/.ubiquity-os.config.yml`):

```yml
plugins:
  - skipBotEvents: true
    uses:
    	# hello-world-plugin
      - plugin: http://127.0.0.1:9090
        runsOn: [ "issue_comment.created" ]
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
