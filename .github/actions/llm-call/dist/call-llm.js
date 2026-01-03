#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const process = require("node:process");

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (!value || !value.startsWith("--")) continue;
    const key = value.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = "true";
    }
  }
  return args;
}

function normalizeBaseUrl(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  return trimmed.replace(/\/+$/, "");
}

function parseBoolean(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function setOutput(name, value) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    fs.appendFileSync(outputFile, `${name}<<EOF\n${value}\nEOF\n`);
    return;
  }
  const escaped = String(value).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  process.stdout.write(`::set-output name=${name}::${escaped}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const authToken = String(process.env.AUTH_TOKEN || "").trim();
  const owner = String(process.env.OWNER || "").trim();
  const repo = String(process.env.REPO || "").trim();
  const messagesRaw = String(process.env.MESSAGES || "").trim();

  if (!authToken) throw new Error("AUTH_TOKEN env is required");
  if (!owner) throw new Error("OWNER env is required");
  if (!repo) throw new Error("REPO env is required");
  if (!messagesRaw) throw new Error("MESSAGES env is required");

  let messages;
  try {
    messages = JSON.parse(messagesRaw);
  } catch (error) {
    throw new Error(`MESSAGES must be valid JSON: ${error}`);
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("MESSAGES must be a non-empty JSON array");
  }

  const baseUrl = normalizeBaseUrl(process.env.UOS_AI_URL) || normalizeBaseUrl(process.env.UOS_AI_BASE_URL) || "https://ai.ubq.fi";
  const model = String(args.model || "gpt-5.2-chat-latest").trim();
  const stream = parseBoolean(args.stream);

  const body = JSON.stringify({
    model,
    messages,
    stream,
  });

  const headers = {
    Authorization: `Bearer ${authToken}`,
    "Content-Type": "application/json",
    "User-Agent": "ubiquity-os-kernel/llm-call-action",
    "X-GitHub-Owner": owner,
    "X-GitHub-Repo": repo,
  };

  const kernelToken = String(process.env.UOS_KERNEL_TOKEN || "").trim();
  if (kernelToken) {
    headers["X-Ubiquity-Kernel-Token"] = kernelToken;
  }

  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers,
    body,
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`LLM call failed (${response.status}): ${text}`);
  }

  setOutput("result", text);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
