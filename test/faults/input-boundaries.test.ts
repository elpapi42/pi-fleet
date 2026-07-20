import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import { resolveMessageInput } from "../../src/cli/input.js";

describe("message input boundaries", () => {
  it.each(["", "   \n\t"])("rejects empty or whitespace-only input", async (input) => {
    await expect(resolveMessageInput("-", Readable.from([input]))).rejects.toThrow(
      /must not be empty/i,
    );
  });

  it("accepts exactly the configured byte limit and rejects one byte more", async () => {
    await expect(resolveMessageInput("-", Readable.from(["abcd"]), 4)).resolves.toBe("abcd");
    await expect(resolveMessageInput("-", Readable.from(["abcde"]), 4)).rejects.toThrow(
      /4-byte limit/i,
    );
  });

  it("aligns the default stdin limit with the runtime message limit", async () => {
    const limit = 512 * 1024;
    await expect(
      resolveMessageInput("-", Readable.from([Buffer.alloc(limit, 0x61)])),
    ).resolves.toHaveLength(limit);
    await expect(
      resolveMessageInput("-", Readable.from([Buffer.alloc(limit + 1, 0x61)])),
    ).rejects.toThrow(/524288-byte limit/i);
  });

  it("rejects invalid UTF-8 instead of silently inserting replacement characters", async () => {
    await expect(
      resolveMessageInput("-", Readable.from([Buffer.from([0xc3, 0x28])])),
    ).rejects.toThrow(/valid UTF-8/i);
  });

  it("preserves valid Unicode exactly", async () => {
    const message = "thinking 🙂 café 日本語\n";
    await expect(resolveMessageInput("-", Readable.from([Buffer.from(message)]))).resolves.toBe(
      message,
    );
  });
});
