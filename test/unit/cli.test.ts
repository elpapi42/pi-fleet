import { describe, expect, it } from "vitest";

import { runCli } from "../../src/entry/cli.js";

function createIo() {
  let stdout = "";
  let stderr = "";

  return {
    io: {
      stderr: {
        write: (chunk: string) => {
          stderr += chunk;
          return true;
        },
      },
      stdout: {
        write: (chunk: string) => {
          stdout += chunk;
          return true;
        },
      },
    },
    read: () => ({ stderr, stdout }),
  };
}

describe("runCli", () => {
  it("prints the package version", () => {
    const output = createIo();

    const exitCode = runCli(["--version"], output.io);

    expect(exitCode).toBe(0);
    expect(output.read()).toEqual({ stderr: "", stdout: "0.0.0-development\n" });
  });

  it("reports that operational commands are not implemented", () => {
    const output = createIo();

    const exitCode = runCli(["list"], output.io);

    expect(exitCode).toBe(1);
    expect(output.read()).toEqual({
      stderr: "pifleet is not implemented yet.\n",
      stdout: "",
    });
  });
});
