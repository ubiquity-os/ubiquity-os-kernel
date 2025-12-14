# Kernel & Plugin Testing Guide (For LLM Agents)

Use this guide to validate kernel/plugin changes quickly. Prefer the mocked Jest tests first; use the CLI harness only when you need to exercise HTTP plugins.

## 🚀 Quick Start

```bash
bun install

# Only needed if you're working on plugin submodules under lib/
bun run setup:plugins
```

## ✅ Unit Tests (Mocked, No Real API Calls)

The Jest suite mocks external dependencies (GitHub API, LLM calls, plugin manifests/dispatch) via MSW.

```bash
# List all tests
bun run jest:test -- --listTests

# Run the kernel-focused suite
bun run jest:test -- tests/kernel.test.ts

# Run a single test by name
bun run jest:test -- tests/kernel.test.ts -t "process /hello"
```

Note: `bun test` is not used for this suite (tests rely on Jest-only APIs like `jest.requireActual`).

## 🔌 Local HTTP Plugin Dispatch (Optional)

`scripts/test-comment.ts` is a local harness that:
- Downloads a repo config from GitHub (`.github/.ubiquity-os.config.dev.yml` then `.github/.ubiquity-os.config.yml`)
- Caches it to `.test-cache/config.yml` (first run downloads + exits; rerun to execute)
- Fetches each HTTP plugin’s `manifest.json`
- For slash commands (`/hello`), POSTs a kernel-shaped payload to the matching plugin URL

Example:

```bash
# Terminal A: start the local hello-world HTTP plugin (127.0.0.1:9090)
bun run plugin:hello-world

# Terminal B: provide a token so the harness can download config
export GITHUB_TOKEN=***redacted***

# First run caches config and exits; run again to dispatch
# (target repo must have a .github/.ubiquity-os.config*.yml that includes http://127.0.0.1:9090 under plugins:)
bun run scripts/test-comment.ts <org> <repo> "/hello"
```

Limitations:
- Only HTTP plugins (config keys that are URLs) are supported; GitHub Action plugins are not executed by this tool.
- `/help` and `@UbiquityOS …` routing is not implemented (slash-command dispatch only).
- The harness currently uses a mock plugin `authToken`, so plugins that call GitHub typically return `401 Unauthorized` (expected). To fully exercise a plugin, update `scripts/test-comment.ts` to pass a real token and use a sandbox repo/issue.

## 🧩 Kernel Config Paths

The kernel loads and merges plugin config from:
- Repo config: `.github/.ubiquity-os.config.yml` (production) or `.github/.ubiquity-os.config.dev.yml` (development)
- Org repo config: `<OWNER>/.ubiquity-os` using the same paths

## 🚨 Troubleshooting

```bash
# Port 9090 already in use
lsof -nP -iTCP:9090 -sTCP:LISTEN

# Reset Jest cache (useful after module-level mock changes)
bun run jest:test -- --clearCache
```

## 🔗 Relevant Files

- `scripts/test-comment.ts`
- `scripts/setup-plugins.ts`
- `src/github/utils/config.ts`
- `src/github/utils/plugins.ts`
- `src/github/utils/workflow-dispatch.ts`
- `tests/kernel.test.ts`
- `tests/__mocks__/hello-world-plugin.ts`
