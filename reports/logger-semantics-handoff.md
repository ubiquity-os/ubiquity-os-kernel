# Logger Semantics Handoff

This repo maps log levels to HTTP-style semantics. Use this when updating other plugins.

- `logger.info`: 1xx, informational steps or starts.
- `logger.ok`: 2xx, successful completion.
- `logger.debug`: 3xx, skipped/ignored paths or alternate flows.
- `logger.warn`: 4xx, client or configuration errors (missing input, permissions, invalid commands).
- `logger.error`: 5xx, server/plugin failures not caused by the user.

Notes:
- For API failures, prefer choosing `warn` vs `error` based on the status code when available.
- If you are logging a skip (e.g., "not an issue event"), prefer `debug`.
- If a log is part of a successful outcome, prefer `ok` over `info`.
