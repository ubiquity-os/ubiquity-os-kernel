import { createAppAuth } from "@octokit/auth-app";
import { Env } from "./types/env";
export async function authenticateApp(env: Env, installationId: number): Promise<void> {
  try {
    const auth = createAppAuth({
      appId: env.APP_ID,
      privateKey: env.PRIVATE_KEY,
      installationId: installationId,
    });

    // Authenticate the app
    const authentication = await auth({ type: "app" });

    console.log("Successfully authenticated as app", authentication);
  } catch (error) {
    console.error("Failed to authenticate app", error);
    throw error;
  }
}
