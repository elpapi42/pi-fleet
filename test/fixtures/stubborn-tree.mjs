import { spawn } from "node:child_process";

process.on("SIGTERM", () => {});
const child = spawn(
  process.execPath,
  ["-e", "process.on('SIGTERM',()=>{}); process.send?.('ready'); setInterval(()=>{},1000)"],
  {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  },
);
child.once("message", () => {
  process.stdout.write(`${JSON.stringify({ parent: process.pid, child: child.pid })}\n`);
});
setInterval(() => {}, 1000);
