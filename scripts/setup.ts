import http from "http";
import fs from "fs";
import path from "path";
import open from "open";
import ora, { Ora } from "ora";
import NodeRSA from "node-rsa";
import { Octokit } from "@octokit/core";
import { confirm, input } from "@inquirer/prompts";

const PORT = 3000;
const DEV_ENV_FILE = ".dev.vars";

const manifestTemplate = {
  url: "https://github.com/ubiquity-os/ubiquity-os-kernel",
  hook_attributes: {
    url: "",
  },
  redirect_url: `http://localhost:${PORT}/redirect`,
  public: true,
  default_permissions: {
    actions: "write",
    issues: "write",
    pull_requests: "write",
    contents: "write",
    members: "read",
  },
  default_events: ["issues", "issue_comment", "label", "pull_request", "push", "repository", "repository_dispatch"],
};

class GithubAppSetup {
  private _octokit: Octokit;
  private _server: http.Server;
  private _spinner: Ora;
  private _url = new URL(`http://localhost:3000`);
  private _env = {
    ENVIRONMENT: "production",
    APP_ID: "",
    APP_PRIVATE_KEY: "",
    APP_WEBHOOK_SECRET: "",
    WEBHOOK_PROXY_URL: `https://smee.io/ubiquityos-kernel-${this.generateRandomString(16)}`,
  };

  constructor() {
    this._octokit = new Octokit();
    this._server = http.createServer(this.handleRequest.bind(this));
    this._spinner = ora("Waiting for Github App creation");
  }

  start() {
    this._server.listen(this._url.port, () => {
      void open(this._url.toString());
      console.log(`If it doesn't open automatically, open this website and follow instructions: ${this._url}`);
      this._spinner.start();
    });
  }

  stop() {
    this._spinner.stop();
    this._server.close();
  }

  async handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    try {
      const url = new URL(`http://localhost${req.url}`);
      if (url.pathname === "/") {
        await this.handleIndexRequest(url, req, res);
      } else if (url.pathname === "/redirect" && req.method === "GET") {
        await this.handleRedirectRequest(url, req, res);
      } else {
        this.send404Response(res);
      }
    } catch (error) {
      console.error(error);
      this.send500Response(res);
    }
  }

  send404Response(res: http.ServerResponse) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("404 Not Found");
  }

  send500Response(res: http.ServerResponse) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Server Error");
  }

  sendHtml(res: http.ServerResponse, content: string) {
    res.writeHead(500, { "Content-Type": "text/html" });
    res.end(content);
  }

  fileExists(file: string) {
    try {
      fs.accessSync(file);
      return true;
    } catch (error) {
      return false;
    }
  }

  generateRandomString(length: number) {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let randomString = "";
    for (let i = 0; i < length; i++) {
      randomString += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return randomString;
  }

  saveEnv(file: string, env: Record<string, unknown>) {
    const envContent = Object.entries(env)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");

    fs.writeFileSync(path.join(__dirname, "..", file), envContent, { flag: "a" });
  }

  async handleIndexRequest(url: URL, req: http.IncomingMessage, res: http.ServerResponse) {
    const manifest = { ...manifestTemplate };
    manifest.hook_attributes.url = this._env.WEBHOOK_PROXY_URL;

    const htmlContent = fs.readFileSync(path.join(__dirname, "index.html")).toString().replace("{{ MANIFEST }}", JSON.stringify(manifest));
    this.sendHtml(res, htmlContent);
  }

  async handleRedirectRequest(url: URL, req: http.IncomingMessage, res: http.ServerResponse) {
    const code = url.searchParams.get("code");
    if (!code) {
      return this.send404Response(res);
    }

    const { data } = await this._octokit.request("POST /app-manifests/{code}/conversions", {
      code,
    });

    const htmlContent = fs.readFileSync(path.join(__dirname, "redirect.html")).toString().replace("{{ APP_URL }}", data.html_url);
    this.sendHtml(res, htmlContent);

    this._server.close();
    this._spinner.succeed("Github App created successfully");

    // convert from pkcs1 to pkcs8
    const privateKey = new NodeRSA(data.pem, "pkcs1-private-pem");
    const privateKeyPkcs8 = privateKey.exportKey("pkcs8-private-pem").replaceAll("\n", "\\n");

    this._env.APP_ID = data.id.toString();
    this._env.APP_PRIVATE_KEY = privateKeyPkcs8;
    this._env.APP_WEBHOOK_SECRET = data.webhook_secret ?? "";

    const envFile = await input({ message: "Enter file name to save env:", default: DEV_ENV_FILE });
    if (this.fileExists(envFile) && !(await confirm({ message: "File already exist. Do you want to append to it?", default: false }))) {
      return;
    }
    this.saveEnv(envFile, this._env);

    process.exit();
  }
}

const setup = new GithubAppSetup();
setup.start();

process.on("SIGINT", () => {
  setup.stop();
  console.log("\nProcess interrupted. Exiting gracefully...");
  process.exit();
});
