
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
bun
bun dev
```

## Testing

### Jest

To start Jest tests, run

```shell
yarn test
```
