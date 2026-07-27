import { createInterface } from "node:readline";

if (process.argv.includes("--version")) {
  process.stdout.write("0.82.1\n");
  process.exit(0);
}

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
  if ((requests === 1 || mode === "idle" || mode === "semantic") && request.type === "get_state") {
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

  if (mode === "semantic" && (request.type === "prompt" || request.type === "follow_up")) {
    process.stdout.write(
      `${response(request.id, request.type)}\n` +
        `${JSON.stringify({ type: "agent_start" })}\n` +
        `${JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "working" } })}\n` +
        `${JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "working" } })}\n` +
        `${JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "done" } })}\n` +
        `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } })}\n` +
        `${JSON.stringify({ type: "agent_settled" })}\n`,
    );
    return;
  }

  if (mode === "normal" && request.type === "compact") {
    process.stdout.write(
      `${response(request.id, "compact", {
        summary: "PRIVATE_COMPACTION_SUMMARY",
        firstKeptEntryId: "entry-1",
        tokensBefore: 1200,
        estimatedTokensAfter: 300,
      })}\n`,
    );
    return;
  }

  if (mode === "expect-follow-up") {
    if (request.type !== "follow_up") {
      process.stdout.write(
        `${JSON.stringify({
          id: request.id,
          type: "response",
          command: request.type,
          success: false,
          error: "expected follow_up",
        })}\n`,
      );
      return;
    }
    process.stdout.write(`${response(request.id, "follow_up")}\n`);
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
    case "invalid-utf8":
      process.stdout.write(
        Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d, 0x0a]),
      );
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
    case "split-oversized": {
      const frame = Buffer.from(`${JSON.stringify({ payload: "x".repeat(16_384) })}\n`);
      process.stdout.write(frame.subarray(0, 8_192));
      setImmediate(() => process.stdout.write(frame.subarray(8_192)));
      return;
    }
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
