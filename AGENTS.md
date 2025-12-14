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

`scripts/test-command.ts` is a local harness that:
- Downloads a repo config from GitHub (`.github/.ubiquity-os.config.dev.yml` then `.github/.ubiquity-os.config.yml`)
- Caches it to `.test-cache/config.yml` (first run downloads + exits; rerun to execute)
- Fetches each HTTP plugin's `manifest.json`
- For slash commands (`/hello`), POSTs a kernel-shaped payload to the matching plugin URL

Example:

```bash
# Terminal A: start the local hello-world HTTP plugin (127.0.0.1:9090)
bun run plugin:hello-world

# Terminal B: provide a token so the harness can download config
export GITHUB_TOKEN=***redacted***

# First run caches config and exits; run again to dispatch
# (target repo must have a .github/.ubiquity-os.config*.yml that includes http://127.0.0.1:9090 under plugins:)
bun run scripts/test-command.ts hello https://github.com/0x4007/ubiquity-os-sandbox/issues/2
```

Limitations:
- Only HTTP plugins (config keys that are URLs) are supported; GitHub Action plugins are not executed by this tool.
- `/help` and `@UbiquityOS …` routing is not implemented (slash-command dispatch only).
- The harness currently uses a mock plugin `authToken`, so plugins that call GitHub typically return `401 Unauthorized` (expected). To fully exercise a plugin, update `scripts/test-command.ts` to pass a real token and use a sandbox repo/issue.

## 🧪 End-to-End Plugin Testing

For complete autonomous testing of plugin commands, use the simplified CLI with GitHub CLI verification:

### **Prerequisites**
```bash
# Install GitHub CLI and authenticate
gh auth login

# Set up environment variables
export APP_ID=your_github_app_id
export APP_PRIVATE_KEY="$(cat path/to/private-key.pem)"
```

### **Complete E2E Test Flow**

1. **Start your plugin locally** (if testing HTTP plugins):
```bash
# Example for hello-world plugin
bun run plugin:hello-world  # Runs on http://127.0.0.1:9090
```

2. **Execute command via test harness**:
```bash
# Simple syntax: command + GitHub URL
bun run test-command hello https://github.com/0x4007/ubiquity-os-sandbox/issues/2
```

3. **Verify comment was posted**:
```bash
# Check the latest comment on the issue
gh issue view 2 --repo 0x4007/ubiquity-os-sandbox --comments --json comments | jq '.comments[-1].body'
```

4. **Full autonomous verification**:
```bash
# One-liner to test and verify
bun run scripts/test-command.ts hello https://github.com/0x4007/ubiquity-os-sandbox/issues/2 && \
sleep 3 && \
echo "🔍 Verifying comment was posted..." && \
gh issue view 2 --repo 0x4007/ubiquity-os-sandbox --comments --json comments | jq -r '.comments[-1].body'
```

### **Testing Different Commands**

```bash
# Test help command
bun run test-command help https://github.com/0x4007/ubiquity-os-sandbox/issues/3 && \
sleep 3 && \
gh issue view 3 --repo 0x4007/ubiquity-os-sandbox --comments --json comments | jq -r '.comments[-1].body'

# Test wallet command
bun run test-command wallet https://github.com/0x4007/ubiquity-os-sandbox/issues/4 && \
sleep 3 && \
gh issue view 4 --repo 0x4007/ubiquity-os-sandbox --comments --json comments | jq -r '.comments[-1].body'
```

### **Automated Testing Script**

Create `test-plugin-e2e.sh` for automated testing:

```bash
#!/bin/bash
set -e

COMMAND=$1
ISSUE_URL=$2
REPO=$(echo $ISSUE_URL | sed 's|https://github.com/\([^/]*\)/\([^/]*\)/issues/\([0-9]*\)|\1/\2|')
ISSUE_NUM=$(echo $ISSUE_URL | sed 's|https://github.com/\([^/]*\)/\([^/]*\)/issues/\([0-9]*\)|\3|')

echo "🧪 Testing /$COMMAND on $REPO issue #$ISSUE_NUM"

# Execute command
bun run test-command $COMMAND $ISSUE_URL

# Wait for processing
sleep 5

# Verify comment was posted
echo "🔍 Verifying comment..."
COMMENT=$(gh issue view $ISSUE_NUM --repo $REPO --comments --json comments | jq -r '.comments[-1].body')

if [[ $COMMENT == *"Error"* ]] || [[ $COMMENT == *"failed"* ]]; then
  echo "❌ Test FAILED - Command returned error"
  echo "Comment: $COMMENT"
  exit 1
else
  echo "✅ Test PASSED - Command executed successfully"
  echo "Comment preview: ${COMMENT:0:100}..."
fi
```

Usage:
```bash
chmod +x test-plugin-e2e.sh
./test-plugin-e2e.sh hello https://github.com/0x4007/ubiquity-os-sandbox/issues/2
```

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

- `scripts/test-command.ts`
- `scripts/setup-plugins.ts`
- `src/github/utils/config.ts`
- `src/github/utils/plugins.ts`
- `src/github/utils/workflow-dispatch.ts`
- `tests/kernel.test.ts`
- `tests/__mocks__/hello-world-plugin.ts`
