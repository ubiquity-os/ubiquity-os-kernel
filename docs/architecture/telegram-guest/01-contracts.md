# Contracts (Freeze This First)

This doc defines the **interfaces** between:

- Kernel guest Telegram ingress
- KV storage
- Memory service (vector embeddings + search)
- Telegram-native plugins

All parallel implementation work must conform to this contract.

## Versioning

- Contract version: `v1`
- All HTTP endpoints use `/v1/...` paths.

## Identifiers

### `workspaceId`

For DM-only guest MVP:

```
workspaceId := "telegram:user:" + <telegramUserId>
```

Examples:
- `telegram:user:123456789`

Rules:
- Stable, deterministic from Telegram user ID.
- Used as the **tenant boundary** everywhere (KV keys, vector DB scoping, plugin state).

### `conversationId`

For DM-only MVP:

```
conversationId := workspaceId
```

Later (optional): allow multiple conversations per workspace (e.g., user-created topics) but do not include that in MVP contracts.

### `messageId`

Requirements:
- Unique per message.
- Prefer time-sortable.

Recommended:
- ULID (26 chars) or `timestampMs + ":" + randomSuffix`.

`messageId` is the primary key for:
- KV message log entries
- Vector DB rows (memory indexing)

## KV Data Shapes

All KV keys use this prefix:

```
["ubiquityos", "assistant", "v1", ...]
```

### Workspace Record

Key:

```
["ubiquityos", "assistant", "v1", "workspace", <workspaceId>]
```

Value:

```json
{
  "workspaceId": "telegram:user:123",
  "createdAt": "2026-02-06T00:00:00.000Z",
  "platform": "telegram",
  "telegram": { "userId": 123 }
}
```

### Message Record (Append-Only Log)

Key:

```
["ubiquityos", "assistant", "v1", "message", <workspaceId>, <messageId>]
```

Value:

```json
{
  "workspaceId": "telegram:user:123",
  "conversationId": "telegram:user:123",
  "messageId": "01J...ULID",
  "role": "user",
  "text": "buy milk tomorrow",
  "createdAt": "2026-02-06T18:00:00.000Z",
  "platform": "telegram",
  "telegram": {
    "userId": 123,
    "chatId": 123,
    "messageId": 555
  },
  "meta": {
    "source": "telegram_dm"
  }
}
```

Notes:
- `role` is one of: `user`, `assistant`, `tool`.
- `text` is stored as-is (no markdown normalization required for storage).

### Recent Index (Fast Recent Transcript)

Key:

```
["ubiquityos", "assistant", "v1", "recent", <workspaceId>]
```

Value:

```json
{
  "workspaceId": "telegram:user:123",
  "updatedAt": "2026-02-06T18:01:00.000Z",
  "messageIds": ["01J...","01J..."]
}
```

Behavior:
- Kernel maintains this list when appending messages.
- Cap the list length (e.g., 50-200) to keep reads fast.

## Service Authentication (Kernel-Signed Requests)

Guest services (memory + plugins) must not accept arbitrary public requests.

Auth scheme (v1):

- Kernel signs the request **body bytes** with RSA SHA-256 using the kernel private key.
- Services verify using the kernel **public key**.

Headers:

- `X-UOS-Expires-At`: unix ms timestamp (string).
- `X-UOS-Body-SHA256`: base64url of SHA-256(body bytes).
- `X-UOS-Signature`: base64 RSA signature of the string:

```
"v1\n" + <method> + "\n" + <path> + "\n" + <X-UOS-Body-SHA256> + "\n" + <X-UOS-Expires-At> + "\n"
```

Rules:
- Reject if `expiresAtMs < nowMs` (allow small clock skew, e.g., 60s).
- Reject if signature invalid.

Deployment:
- Services are configured with `KERNEL_PUBLIC_KEY` (already used in existing plugins).

## Memory Service (Vector Index + Search)

Base URL: configured in kernel (MVP can hardcode; later can be KV-managed).

### `POST /v1/index`

Purpose:
- Index one or more messages into semantic memory.
- Tenant-scoped by `workspaceId`.

Request:

```json
{
  "workspaceId": "telegram:user:123",
  "items": [
    {
      "messageId": "01J...ULID",
      "conversationId": "telegram:user:123",
      "role": "user",
      "text": "buy milk tomorrow",
      "createdAt": "2026-02-06T18:00:00.000Z",
      "metadata": {
        "platform": "telegram"
      }
    }
  ]
}
```

Response:
- `202 Accepted` (indexing may be async)

Body:

```json
{
  "indexed": 1,
  "skipped": 0,
  "errors": []
}
```

Rules:
- Never return `{ "ok": true }` style bodies. Use status codes.
- Service may skip embedding short/noisy content (implementation detail), but should report `skipped`.

### `POST /v1/search`

Purpose:
- Retrieve semantically similar messages for a user query.

Request:

```json
{
  "workspaceId": "telegram:user:123",
  "query": {
    "text": "what did i say about groceries?",
    "createdAt": "2026-02-06T18:05:00.000Z"
  },
  "topK": 5,
  "threshold": 0.75
}
```

Response:
- `200 OK`

Body:

```json
{
  "matches": [
    { "messageId": "01J...ULID", "score": 0.83, "createdAt": "2026-02-01T12:00:00.000Z" }
  ],
  "tookMs": 42
}
```

Rules:
- Results must be strictly scoped to `workspaceId`.
- Service should not leak raw embeddings.
- Service may omit snippets; kernel can fetch text from KV by `messageId`.

## Telegram Plugin Manifest

Each Telegram-native plugin is an HTTP service and must expose:

### `GET /manifest.json`

Response `200 OK`:

```json
{
  "schemaVersion": 1,
  "id": "uos.telegram.notes",
  "name": "Notes",
  "description": "Store and retrieve personal notes.",
  "commands": {
    "note.add": {
      "description": "Add a note.",
      "examples": ["note.add buy milk tomorrow"],
      "parameters": {
        "type": "object",
        "properties": {
          "text": { "type": "string" }
        },
        "required": ["text"]
      }
    }
  }
}
```

Notes:
- `parameters` is JSON Schema (draft-agnostic subset is fine for v1).
- Kernel uses manifests to build help text and router prompt command lists.

## Telegram Plugin Dispatch

### `POST /v1/dispatch`

Purpose:
- Execute a plugin command for a guest workspace.

Request:

```json
{
  "requestId": "2c6c1d4c-9f8b-4d9d-9d36-7b6d6f9d6f36",
  "workspaceId": "telegram:user:123",
  "conversationId": "telegram:user:123",
  "platform": "telegram",
  "command": {
    "name": "note.add",
    "parameters": { "text": "buy milk tomorrow" }
  },
  "context": {
    "recentMessages": [
      { "role": "user", "text": "buy milk tomorrow", "createdAt": "2026-02-06T18:00:00.000Z" }
    ],
    "memoryMatches": [
      { "messageId": "01J...ULID", "score": 0.83, "text": "..." }
    ],
    "telegram": {
      "userId": 123,
      "chatId": 123
    }
  }
}
```

Response:
- `200 OK`

Body:

```json
{
  "messages": [
    { "text": "Saved.", "parseMode": "plain" }
  ],
  "writes": {
    "kv": []
  }
}
```

Rules:
- Plugins should not call Telegram directly; kernel is responsible for sending messages.
- `writes.kv` is reserved for future; for v1, prefer kernel-owned KV writes to keep state centralized.
- No `{ "ok": true }` responses.

## Router Output Contract (Kernel <-> LLM)

The router LLM must return **only JSON** with one of:

### Reply

```json
{ "action": "reply", "reply": "..." }
```

### Command

```json
{
  "action": "command",
  "command": {
    "name": "note.add",
    "parameters": { "text": "buy milk tomorrow" }
  }
}
```

### Help / Ignore

```json
{ "action": "help" }
```

```json
{ "action": "ignore" }
```

Rules:
- If `action=command`, `command.name` must be one of the allowed plugin commands.
- No keyword/regex trigger routing in code; decision must be prompt-driven.

