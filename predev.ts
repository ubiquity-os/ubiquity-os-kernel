const PORT = 8787;
const isWindows = Deno.build.os === "windows";

type CommandResult = {
  stdout: string;
  success: boolean;
};

async function runCommand(command: string, args: string[]): Promise<CommandResult> {
  try {
    const output = await new Deno.Command(command, {
      args,
      stdout: "piped",
      stderr: "piped",
    }).output();

    return {
      stdout: new TextDecoder().decode(output.stdout),
      success: output.success,
    };
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      console.warn(`Command not found: ${command}`);
      return { stdout: "", success: false };
    }
    console.warn(`Failed to run ${command}: ${error}`);
    return { stdout: "", success: false };
  }
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

async function getPidsForPort(port: number): Promise<string[]> {
  if (isWindows) {
    const { stdout } = await runCommand("netstat", ["-ano"]);
    if (!stdout) return [];
    const lines = stdout.split(/\r?\n/).map((line) => line.trim());
    const pids = lines
      .filter((line) => line.includes("LISTENING") && line.includes(`:${port}`))
      .map((line) => line.split(/\s+/).pop())
      .filter((pid): pid is string => Boolean(pid));
    return unique(pids);
  }

  const { stdout } = await runCommand("lsof", ["-ti", `tcp:${port}`]);
  if (!stdout) return [];
  return unique(stdout.split(/\s+/).filter(Boolean));
}

async function killPid(pid: string): Promise<void> {
  if (isWindows) {
    await runCommand("taskkill", ["/F", "/PID", pid]);
  } else {
    await runCommand("kill", ["-9", pid]);
  }
}

const pids = await getPidsForPort(PORT);

if (!pids.length) {
  console.log(`No process listening on port ${PORT}.`);
  Deno.exit(0);
}

for (const pid of pids) {
  await killPid(pid);
  console.log(`Process ${pid} killed successfully.`);
}
