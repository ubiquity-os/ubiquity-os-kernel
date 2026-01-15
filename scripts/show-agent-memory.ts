#!/usr/bin/env -S deno run --allow-env --allow-net

import { parse } from "https://deno.land/std@0.203.0/flags/mod.ts";
import { listAgentMemoryEntries } from "../src/github/utils/agent-memory.ts";

const DEFAULT_LIMIT = 25;
const OWNER_KEY = "owner";
const REPO_KEY = "repo";
const LIMIT_KEY = "limit";
const SCOPE_KEY = "scope";
const ISSUE_KEY = "issue";
const KERNEL_URL_KEY = "kernel-url";
const TOKEN_KEY = "token";
const JSON_KEY = "json";

const parsed = parse(Deno.args, {
  alias: {
    o: OWNER_KEY,
    r: REPO_KEY,
    l: LIMIT_KEY,
    s: SCOPE_KEY,
    i: ISSUE_KEY,
    k: KERNEL_URL_KEY,
    t: TOKEN_KEY,
    j: JSON_KEY,
  },
  boolean: [JSON_KEY],
  default: {
    [LIMIT_KEY]: String(DEFAULT_LIMIT),
  },
});

const owner = typeof parsed[OWNER_KEY] === "string" ? parsed[OWNER_KEY].trim() : "";
const repo = typeof parsed[REPO_KEY] === "string" ? parsed[REPO_KEY].trim() : "";
const scopeKey = typeof parsed[SCOPE_KEY] === "string" ? parsed[SCOPE_KEY].trim() : undefined;
const kernelUrl = typeof parsed[KERNEL_URL_KEY] === "string" ? parsed[KERNEL_URL_KEY].trim() : "";
const token = typeof parsed[TOKEN_KEY] === "string" ? parsed[TOKEN_KEY].trim() : (Deno.env.get("UOS_DIAGNOSTICS_TOKEN") ?? "").trim();
const issueRaw = typeof parsed[ISSUE_KEY] === "string" ? parsed[ISSUE_KEY].trim() : "";

if (!owner || !repo) {
  console.error(
    `Usage: show-agent-memory.ts --${OWNER_KEY}=<org> --${REPO_KEY}=<repo> [--${LIMIT_KEY}=<n>] [--${SCOPE_KEY}=<scopeKey>] [--${ISSUE_KEY}=<n>] [--${KERNEL_URL_KEY}=<url>] [--${TOKEN_KEY}=<token>] [--${JSON_KEY}]`
  );
  Deno.exit(1);
}
if (kernelUrl && !token) {
  console.error("Missing diagnostics token. Provide --token or set UOS_DIAGNOSTICS_TOKEN.");
  Deno.exit(1);
}

const limitValue = Number(parsed[LIMIT_KEY] ?? DEFAULT_LIMIT);
const limit = Number.isFinite(limitValue) && limitValue > 0 ? Math.trunc(limitValue) : DEFAULT_LIMIT;

const issueNumber = Number.isFinite(Number(issueRaw)) && Number(issueRaw) > 0 ? Math.trunc(Number(issueRaw)) : undefined;

async function fetchEntries() {
  if (!kernelUrl) {
    return listAgentMemoryEntries({
      owner,
      repo,
      limit,
      scopeKey,
    });
  }

  const endpoint = new URL("/internal/agent-memory", kernelUrl);
  endpoint.searchParams.set(OWNER_KEY, owner);
  endpoint.searchParams.set(REPO_KEY, repo);
  endpoint.searchParams.set(LIMIT_KEY, String(limit));
  if (scopeKey) endpoint.searchParams.set(SCOPE_KEY, scopeKey);
  if (issueNumber) endpoint.searchParams.set(ISSUE_KEY, String(issueNumber));

  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
  const response = await fetch(endpoint, { headers });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`${response.status} ${response.statusText}: ${text}`);
  }

  const payload = await response.json();
  return Array.isArray(payload?.entries) ? payload.entries : [];
}

let entries = await fetchEntries();
if (issueNumber) {
  entries = entries.filter((entry) => entry.issueNumber === issueNumber);
}

if (parsed[JSON_KEY]) {
  console.log(JSON.stringify(entries, null, 2));
  Deno.exit(entries.length === 0 ? 1 : 0);
}

const scopeInfo = scopeKey ? ` (scope: ${scopeKey})` : "";
console.log(`Agent-memory queue for ${owner}/${repo}${scopeInfo} – showing ${entries.length} of up to ${limit}`);
if (!entries.length) {
  console.log("No pending agent runs found in the KV queue.");
  Deno.exit(0);
}

entries.forEach((entry, index) => {
  const summary = entry.summary ? ` - ${entry.summary}` : "";
  let link = "";
  if (entry.runUrl) {
    link = ` run:${entry.runUrl}`;
  } else if (entry.prUrl) {
    link = ` pr:${entry.prUrl}`;
  }
  console.log(`${index + 1}. [${entry.updatedAt}] #${entry.issueNumber} ${entry.status}${summary} (${entry.stateId})${link}`);
});

console.log(
  kernelUrl
    ? "Fetched entries via kernel diagnostics endpoint."
    : "Set --kernel-url to the kernel deployment URL to fetch remotely (requires diagnostics token)."
);
