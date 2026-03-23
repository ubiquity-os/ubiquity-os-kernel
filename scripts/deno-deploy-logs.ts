#!/usr/bin/env deno run --allow-run
// deno-deploy-logs.ts - Download Deno Deploy project logs

const args = Deno.args;
const project = args.find((a) => a.startsWith("--project="))?.split("=")[1] || "ubiquity-os-kernel";
const since = parseInt(args.find((a) => a.startsWith("--since="))?.split("=")[1] || "1");

const start = new Date(Date.now() - since * 3600 * 1000).toISOString();
const end = new Date().toISOString();

const cmd = new Deno.Command("deployctl", {
  args: ["logs", "--project", project, "--start", start, "--end", end],
  stdout: "piped",
  stderr: "piped",
});

const { code, stdout, stderr } = await cmd.output();

if (code !== 0) {
  console.error(new TextDecoder().decode(stderr));
  Deno.exit(code);
}

console.log(new TextDecoder().decode(stdout));
