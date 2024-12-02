import { Hono } from "hono";
const app = new Hono();

app.get("/", (c) => c.text("Hello Azure Functions!"));

export default app;
