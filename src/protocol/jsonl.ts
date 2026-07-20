import type { Socket } from "node:net";

import { MAX_PROTOCOL_FRAME_BYTES } from "./version.js";

export function readJsonLines(
  socket: Socket,
  onValue: (value: unknown) => void,
  onError: (error: Error) => void,
): () => void {
  let buffer = Buffer.alloc(0);
  const onData = (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) {
        if (buffer.length > MAX_PROTOCOL_FRAME_BYTES) {
          onError(new Error("Protocol frame exceeds maximum size"));
        }
        return;
      }
      if (newline > MAX_PROTOCOL_FRAME_BYTES) {
        onError(new Error("Protocol frame exceeds maximum size"));
        return;
      }
      const line = buffer.subarray(0, newline).toString("utf8").replace(/\r$/, "");
      buffer = buffer.subarray(newline + 1);
      if (line.length === 0) continue;
      try {
        onValue(JSON.parse(line));
      } catch {
        onError(new Error("Malformed JSON protocol frame"));
        return;
      }
    }
  };
  socket.on("data", onData);
  return () => socket.off("data", onData);
}

export function writeJsonLine(socket: Socket, value: unknown): void {
  socket.write(`${JSON.stringify(value)}\n`);
}
