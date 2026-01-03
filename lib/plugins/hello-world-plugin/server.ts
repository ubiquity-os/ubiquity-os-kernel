#!/usr/bin/env bun

import worker from "./src/worker";

const port = 9090;

console.log(`🚀 Starting hello-world-plugin on port ${port}`);

Bun.serve({
  port,
  async fetch(request) {
    // Mock environment for local development
    const env = {
      LOG_LEVEL: "INFO",
      KERNEL_PUBLIC_KEY: "mock-key",
      NODE_ENV: "local",
    };

    return worker.fetch(request, env);
  },
});

console.log(`✅ Hello world plugin running at http://localhost:${port}`);
console.log(`📄 Manifest available at http://localhost:${port}/manifest.json`);
