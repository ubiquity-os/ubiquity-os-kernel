# @ubiquity/ubiquibot-kernel

The kernel is designed to:

- Interface with plugins (GitHub Actions) for longer running processes.
- Run on Cloudflare Workers.

## Environment Variables

- **`PRIVATE_KEY`**
  Obtain a private key from your GitHub App settings and convert it to the Public-Key Cryptography Standards #8 (PKCS#8) format. Use the following command to perform this conversion and append the result to your `.dev.vars` file:

    ```sh
    echo "PRIVATE_KEY=\"$(openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in YOUR_PRIVATE_KEY.PEM | awk 'BEGIN{ORS="\\n"} 1')\"" >> .dev.vars
    ```

    **Note:** Replace `YOUR_PRIVATE_KEY.PEM` with the path to your actual PEM file when running the command.

- **`WEBHOOK_SECRET`**
  Set this value in both your GitHub App settings and here.

- **`APP_ID`**
  Retrieve this from your GitHub App settings.

- **`WEBHOOK_PROXY_URL` (only for development)**
  Obtain a webhook URL at [smee.io](https://smee.io/) and set it in your GitHub App settings.

### Quick Start

```bash
git clone https://github.com/ubiquity/ubiquibot-kernel
cd ubiquibot-kernel
bun install
bun dev
```

### Deploying to Cloudflare Workers

1. **Install Dependencies:**
   - Execute `bun install` to install the required dependencies.

2. **Create a Github App:**
   - Generate a Github App and configure its settings.
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
   - For the private key, execute the following (replace `YOUR_PRIVATE_KEY.PEM` with the actual PEM file path):

     ```sh
     echo $(openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in YOUR_PRIVATE_KEY.PEM) | npx wrangler secret put PRIVATE_KEY --env dev
     ```

6. **Deploy the Kernel:**
   - Execute `bun run deploy-dev` to deploy the kernel.

### Plugin Input and Output

#### Input

Inputs are received within the workflow, triggered by the `workflow_dispatch` event. The plugin is designed to handle the following inputs:

- `stateId`: An identifier used to track the state of plugin chain execution in Cloudflare KV. It is crucial to pass this identifier back in the output.
- `eventName`: The complete name of the event (e.g., `issue_comment.created`).
- `eventPayload`: The payload associated with the event.
- `settings`: A string containing JSON with settings specific to your plugin. The plugin itself defines these settings.
- `authToken`: A JWT token for accessing GitHub's API to the repository where the event occurred.
- `ref`: A reference (branch, tag, commit SHA) indicating the version of the plugin to be utilized.

#### Output

Data is returned using the `repository_dispatch` event on the plugin's repository, and the output is structured within the `client_payload`.
The `event_type` must be set to `return_data_to_ubiquibot_kernel`.

- `state_id`: The state ID passed in the inputs must be included here.
- `output`: A string containing JSON with custom output, defined by the plugin itself.
