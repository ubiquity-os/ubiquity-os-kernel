import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";

export async function myFunc(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  context.log(`Http function processed request for url "${request.url}"`);

  const name = request.query.get("name") || (await request.text()) || "world";

  return { body: `Hello, ${name}!` };
}

app.http("my-func", {
  methods: ["GET", "POST"],
  authLevel: "anonymous",
  handler: myFunc,
});
