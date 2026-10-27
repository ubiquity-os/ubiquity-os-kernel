# Decisions

## 2026-10-27: Persist repository config status on changes and config pushes

The webhook gate writes a repository's reported config status to Workers KV when it differs from the previously read status, including missing or expired entries, or after a config-changing push. Config-changing pushes always reconcile durable status even when a cached value matches the kernel response. Configured events continue to reach the kernel; ordinary unchanged responses consume no status PUT and do not refresh the response cache.

Keep the existing five-minute repository cache and 24-hour KV TTL. Cache misses read durable state, and the next event renews an expired KV entry. Preserve config-changing push bypass, present/absent transitions, organization config version invalidation, signature verification, and dispatch behavior.
