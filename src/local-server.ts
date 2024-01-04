import SmeeClient from "smee-client";
import { Miniflare } from "miniflare";

const path = "/events";

const mf = new Miniflare({
	modules: true,
	scriptPath: "./worker.js",
});

mf.ready
	.then(async (url) => {
		const env = await mf.getBindings();
		if (env.WEBHOOK_PROXY_URL && typeof env.WEBHOOK_PROXY_URL === "string") {
			url.pathname = path;
			const smee = new SmeeClient({
				source: env.WEBHOOK_PROXY_URL,
				target: url.toString(),
				logger: console,
			});

			smee.start();
		}
		console.log(`Listening on ${url}`);
	})
	.catch((err) => {
		console.error(err);
	});
