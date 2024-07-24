import { createServer } from "@mswjs/http-middleware";
import { Octokit } from "@octokit/core";
import { http, HttpResponse } from "msw";
import manifest from "./manifest.json";

type KernelInput = {
  authToken: string;
  eventPayload: {
    issue: {
      number: number;
    };
    organization: {
      login: string;
    };
    repository: {
      name: string;
    };
  };
  settings: {
    response: string;
  };
};

const PORT = 9090;

const handlers = [
  http.post("/", async (data) => {
    const body: KernelInput = (await data.request.json()) as KernelInput;

    const octokit = new Octokit({ auth: body.authToken });

    await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
      owner: body.eventPayload.organization.login,
      repo: body.eventPayload.repository.name,
      issue_number: body.eventPayload.issue.number,
      body: body.settings.response,
      headers: {
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    return HttpResponse.json({
      state_id: "state_id_uuid_1",
      output: `{ "result": "success", "message": "${body.settings.response}" }`,
    });
  }),
  http.get("/manifest.json", () => {
    return HttpResponse.json(manifest);
  }),
];

const httpServer = createServer(...handlers);

httpServer.listen(PORT);
console.log(`hello-world-plugin is listening on http://127.0.0.1:${PORT}`);
