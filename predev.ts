import { exec } from "child_process";

const port = "8787";

const isWindows = process.platform === "win32";

const command = isWindows ? `netstat -ano | findstr LISTENING | findstr :${port}` : `lsof -i tcp:${port} | grep LISTEN | awk '{print $2}'`;

exec(command, (error, stdout) => {
  if (error) {
    // The command will also fail on Windows if the process doesn't exist which is expected
    console.error(`Error executing command: ${error.message}`);
    return;
  }

  const pid = isWindows ? stdout.trim().split(/\s+/)[4] : stdout.trim();

  if (pid) {
    const killCommand = isWindows ? `taskkill /F /PID ${pid}` : `kill -9 ${pid}`;
    exec(killCommand, (error) => {
      if (error) {
        console.error(`Error killing process: ${error.message}`);
        return;
      }
      console.log(`Process ${pid} killed successfully.`);
    });
  }
});
