import { afterEach, describe, expect, it } from "vitest";

import { PiProcess } from "../../src/pi/process.js";

const processes: PiProcess[] = [];
afterEach(async () => {
  await Promise.all(processes.splice(0).map((process) => process.stop().catch(() => undefined)));
});

const scriptedPiPath = new URL("../fixtures/scripted-pi.mjs", import.meta.url).pathname;

describe("PiProcess delivery commands", () => {
  it("durably admits a split oversized complete record before parser failure", async () => {
    const admitted: Buffer[] = [];
    const process = await PiProcess.start({
      executable: globalThis.process.execPath,
      argvPrefix: [scriptedPiPath],
      piArgv: [],
      cwd: "/tmp",
      env: { PIFLEET_TEST_PI_MODE: "split-oversized" },
      maxStdoutFrameBytes: 1_024,
      maxPartialRecordBytes: 32 * 1024,
      onStdoutRecord: (record) => {
        admitted.push(Buffer.from(record));
      },
    });
    processes.push(process);

    await expect(process.prompt("emit oversized")).rejects.toThrow(/parser limit/i);
    const oversized = admitted.find((record) => record.length > 16_000);
    expect(oversized?.at(-1)).toBe(0x0a);
    expect(oversized?.includes(Buffer.from('"payload":"xxx'))).toBe(true);
  });

  it("uses Pi's typed follow_up command", async () => {
    const process = await PiProcess.start({
      executable: globalThis.process.execPath,
      argvPrefix: [scriptedPiPath],
      piArgv: [],
      cwd: "/tmp",
      env: { PIFLEET_TEST_PI_MODE: "expect-follow-up" },
    });
    processes.push(process);

    await expect(process.followUp("continue after the current turn")).resolves.toBeUndefined();
  });
});
