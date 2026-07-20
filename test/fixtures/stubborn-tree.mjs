import { spawn } from "node:child_process";

const child = spawn(
  process.execPath,
  ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"],
  {
    stdio: "ignore",
  },
);
process.stdout.write(`${JSON.stringify({ parent: process.pid, child: child.pid })}\n`);
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
