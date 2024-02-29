# @ubiquity/ubiquibot-kernel

The kernel is designed to:

- Interface with plugins (GitHub Actions) for longer running processes.
- Run on Cloudflare Workers.

## Environment variables

- `PRIVATE_KEY`
  You need to obtain a private key from your GitHub App settings and convert it to Public-Key Cryptography Standards #8 (PKCS#8) format. You can use the following command to perform this conversion and append the result to your `.dev.vars` file:

  ```sh
  echo "PRIVATE_KEY=\"$(openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in YOUR_PRIVATE_KEY.PEM | awk 'BEGIN{ORS="\\n"} 1')\"" >> .dev.vars
  ```

###### Please replace `YOUR_PRIVATE_KEY.PEM` with the path to your actual PEM file when running the command.

- `WEBHOOK_SECRET`
  This should be set in your GitHub App settings and also here.

- `APP_ID`
  You can find this in your GitHub App settings.

- `WEBHOOK_PROXY_URL` (only for development)
  You need to obtain a webhook URL at <https://smee.io/> and set it in the GitHub App settings.

### Quick Start

```bash
git clone https://github.com/ubiquity/ubiquibot-kernel
cd ubiquibot-kernel
bun install
bun dev
```

### Deploying to Cloudflare Workers

1. Install dependencies using `bun install`.

2. Create a Github App. Under app settings click `Permissions & events` and make sure the app is subscribed to all events and have these permissions:

```md
Repository permissions:

- Actions: Read & Write
- Contents: Read & Write
- Issues: Read & Write
- Pull Requests: Read & Write

Organization permissions:

- Members: Read only
```

3. Create a Cloudflare account if you don't have one and run `npx wrangler login`.

4. To create a KV namespace run `npx wrangler kv:namespace create PLUGIN_CHAIN_STATE`. Copy the ID to `wrangler.toml` under `[env.dev]`.

5. You can add (env) secrets using `npx wrangler secret put <KEY> --env dev`. To add private key run: (replace YOUR_PRIVATE_KEY.PEM with the path to your actual PEM file)

```sh
echo $(openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in YOUR_PRIVATE_KEY.PEM) | npx wrangler secret put PRIVATE_KEY --env dev
```

6. To deploy the kernel run `bun run deploy-dev`.
