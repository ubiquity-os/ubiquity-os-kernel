# @ubiquity/ubiquibot-kernel

The bot kernel is designed to:

- Interface with plugins (GitHub Actions) for longer running processes.
- Run on Cloudflare Workers.

## Environment variables

- PRIVATE_KEY
  You need to get a private key from Github App settings and convert it to PKCS#8 using this command:
  `openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in pkcs8.key -out pkcs8.key`

- WEBHOOK_SECRET
  You need to set it in Github App settings and also set it here.

- APP_ID
  You can find this in Github App settings.

- WEBHOOK_PROXY_URL (only for development)
  You need to get a webhook URL at <https://smee.io/> and set it in the Github App settings

- SUPABASE_URL and SUPABASE_KEY
  Supabase client connection details.

- LOG_LEVEL
  Log level, possible values are FATAL, ERROR, INFO, VERBOSE, DEBUG.

- LOG_RETRY_LIMIT
  Maximum number of retries to insert logs to Supabase, set to 0 means no retries will be attempted.


### Quick Start

```bash
git clone https://github.com/ubiquity/ubiquibot-kernel
cd ubiquibot-kernel
bun
bun dev
```
