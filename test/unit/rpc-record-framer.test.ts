import { describe, expect, it } from "vitest";

import { RpcPartialRecordLimitError, RpcRecordFramer } from "../../src/pi/rpc-record-framer.js";

describe("RpcRecordFramer", () => {
  it("preserves exact complete bytes across arbitrary chunk boundaries", () => {
    const bytes = Buffer.from([0xff, 0x00, 0x7b, 0x7d, 0x0d, 0x0a, 0x61, 0x0a]);
    const framer = new RpcRecordFramer(32);

    const records = [
      ...framer.push(bytes.subarray(0, 2)),
      ...framer.push(bytes.subarray(2, 6)),
      ...framer.push(bytes.subarray(6)),
    ];

    expect(records).toEqual([bytes.subarray(0, 6), bytes.subarray(6)]);
    expect(framer.finish()).toBeNull();
  });

  it("emits complete oversized records but bounds unterminated partial data", () => {
    const complete = new RpcRecordFramer(3);
    expect(complete.push(Buffer.from("123456\n"))).toEqual([Buffer.from("123456\n")]);

    const partial = new RpcRecordFramer(3);
    partial.push(Buffer.from("12"));
    expect(() => partial.push(Buffer.from("34"))).toThrow(RpcPartialRecordLimitError);
    expect(() => partial.push(Buffer.from("\n"))).toThrow("framer has failed");
  });

  it("takes ownership of pending chunk bytes", () => {
    const framer = new RpcRecordFramer(16);
    const partial = Buffer.from("part");
    framer.push(partial);
    partial.fill(0x78);
    expect(framer.push(Buffer.from("ial\n"))).toEqual([Buffer.from("partial\n")]);
  });

  it("returns but never emits an interrupted trailing fragment", () => {
    const framer = new RpcRecordFramer(16);
    expect(framer.push(Buffer.from("complete\npartial"))).toEqual([Buffer.from("complete\n")]);
    expect(framer.finish()).toEqual(Buffer.from("partial"));
    expect(framer.finish()).toBeNull();
  });
});
