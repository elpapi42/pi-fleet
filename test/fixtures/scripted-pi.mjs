import { createInterface } from "node:readline";

const mode = process.env.PIFLEET_TEST_PI_MODE ?? "normal";
if (mode === "exit-before-ready") process.exit(19);
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let requests = 0;

function response(id, command, data = {}) {
  return JSON.stringify({ id, type: "response", command, success: true, data });
}

lines.on("line", (line) => {
  const request = JSON.parse(line);
  requests += 1;
  if (requests === 1 && request.type === "get_state") {
    process.stdout.write(
      `${response(request.id, "get_state", {
        isStreaming: false,
        isCompacting: false,
        pendingMessageCount: 0,
        sessionFile: process.env.PIFLEET_TEST_SESSION_PATH ?? "/tmp/scripted-pi.jsonl",
        sessionId: "scripted-pi",
      })}\n`,
    );
    return;
  }

  switch (mode) {
    case "timeout":
      process.stderr.write(process.env.PIFLEET_TEST_CANARY ?? "private-stderr-canary");
      return;
    case "working":
      process.stdout.write(
        `${JSON.stringify({ type: "agent_start" })}\n${response(request.id, request.type)}\n`,
      );
      return;
    case "malformed":
      process.stdout.write("{not-json}\n");
      return;
    case "partial":
      process.stdout.write('{"type":"response"');
      process.exit(20);
      return;
    case "exit":
      process.exit(21);
      return;
    case "unknown":
      process.stdout.write(`${response("unknown-response-id", request.type)}\n`);
      return;
    case "split": {
      const frame = `${response(request.id, request.type)}\n`;
      const middle = Math.floor(frame.length / 2);
      process.stdout.write(frame.slice(0, middle));
      setImmediate(() => process.stdout.write(frame.slice(middle)));
      return;
    }
    case "coalesced":
      process.stdout.write(
        `${JSON.stringify({ type: "agent_start" })}\n${response(request.id, request.type)}\n`,
      );
      return;
    case "duplicate": {
      const frame = `${response(request.id, request.type)}\n`;
      process.stdout.write(`${frame}${frame}`);
      return;
    }
    case "oversized":
      process.stdout.write(`${JSON.stringify({ payload: "x".repeat(16_384) })}\n`);
      return;
    case "reject":
      process.stdout.write(
        `${JSON.stringify({
          id: request.id,
          type: "response",
          command: request.type,
          success: false,
          error: "scripted rejection",
        })}\n`,
      );
      return;
    default:
      process.stdout.write(`${response(request.id, request.type)}\n`);
  }
});
