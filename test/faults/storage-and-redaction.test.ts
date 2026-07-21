import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { SocketFleetClient } from "../../src/client/socket-fleet-client.js";
import type { PiLauncher } from "../../src/pi/adapter.js";
import { PiProcess } from "../../src/pi/process.js";
import { startControlServer, type ControlServer } from "../../src/runtime/control-server.js";
import { FleetService } from "../../src/runtime/fleet-service.js";
import { MemoryFleetStore } from "../../src/store/memory-store.js";
import { SqliteFleetStore } from "../../src/store/sqlite-store.js";
import { WorkerFleetStore } from "../../src/store/worker-store.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const faultyWorkerUrl = new URL("../fixtures/faulty-store-worker.mjs", import.meta.url);
const scriptedPiPath = new URL("../fixtures/scripted-pi.mjs", import.meta.url).pathname;

async function rejectsPrompt(mode: string, options: { maxFrameBytes?: number } = {}) {
  const process = await PiProcess.start({
    executable: processExecutable(),
    argvPrefix: [scriptedPiPath],
    piArgv: [],
    cwd: tmpdir(),
    env: {
      PIFLEET_TEST_PI_MODE: mode,
      PIFLEET_TEST_CANARY: "PRIVATE_STDERR_CANARY",
    },
    ...(options.maxFrameBytes === undefined ? {} : { maxStdoutFrameBytes: options.maxFrameBytes }),
  });
  cleanups.push(() => process.stop().catch(() => undefined));
  return process;
}

function processExecutable(): string {
  return globalThis.process.execPath;
}

async function within<T>(promise: Promise<T>, milliseconds = 1_000): Promise<T> {
  let timer!: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("operation did not terminate")), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

describe("storage failure containment", () => {
  it("rejects current and future calls after the SQLite worker exits", async () => {
    const store = new WorkerFleetStore("exit", faultyWorkerUrl);
    await expect(within(store.listAgents())).rejects.toThrow("SQLite worker exited unexpectedly");
    await expect(within(store.listAgents())).rejects.toThrow("SQLite worker exited unexpectedly");
    await store.close(false);
  });

  it("fails closed when the SQLite worker returns a malformed response", async () => {
    const store = new WorkerFleetStore("malformed", faultyWorkerUrl);
    await expect(within(store.listAgents())).rejects.toThrow("malformed response");
    await expect(within(store.listAgents())).rejects.toThrow("malformed response");
    await store.close(false);
  });

  it("refuses a corrupt database without replacing the user state file", async () => {
    const root = await mkdtemp(join(tmpdir(), "pifleet-corrupt-store-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const path = join(root, "fleet.sqlite");
    const corruption = Buffer.from("not a sqlite database: PRIVATE_DATABASE_CANARY");
    await writeFile(path, corruption);

    expect(() => new SqliteFleetStore(path)).toThrow();
    await expect(readFile(path)).resolves.toEqual(corruption);
  });

  it("fails rather than mutating a database held by another exclusive writer", async () => {
    const root = await mkdtemp(join(tmpdir(), "pifleet-locked-store-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const path = join(root, "fleet.sqlite");
    const initial = new SqliteFleetStore(path);
    await initial.close();
    const lock = new DatabaseSync(path);
    lock.exec("BEGIN EXCLUSIVE");
    try {
      expect(() => new SqliteFleetStore(path)).toThrow(/locked/i);
    } finally {
      lock.exec("ROLLBACK");
      lock.close();
    }
  });

  it("runs an integrity check before reconciling an unclean database", async () => {
    const root = await mkdtemp(join(tmpdir(), "pifleet-unclean-integrity-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const path = join(root, "fleet.sqlite");
    const initial = new SqliteFleetStore(path);
    await initial.close(false);

    const inspected = new DatabaseSync(path);
    const pageSize = (inspected.prepare("PRAGMA page_size").get() as { page_size: number })
      .page_size;
    const sendRecords = inspected
      .prepare("SELECT rootpage FROM sqlite_schema WHERE name = 'send_records'")
      .get() as { rootpage: number };
    inspected.close();

    const file = await open(path, "r+");
    try {
      await file.write(Buffer.from([0xff]), 0, 1, (sendRecords.rootpage - 1) * pageSize);
    } finally {
      await file.close();
    }
    const corrupted = await readFile(path);

    expect(() => new SqliteFleetStore(path)).toThrow(/integrity|malformed/i);
    await expect(readFile(path)).resolves.toEqual(corrupted);
  });
});

describe("Pi RPC failure containment", () => {
  it("returns only bounded native compaction metrics", async () => {
    const pi = await rejectsPrompt("normal");
    await expect(pi.compact()).resolves.toEqual({
      tokensBefore: 1200,
      estimatedTokensAfter: 300,
    });
  });

  it("classifies native compact rejection without exposing its message", async () => {
    const pi = await rejectsPrompt("reject");
    await expect(pi.compact()).rejects.toMatchObject({ code: "compaction_failed" });
  });

  it("rejects startup when Pi exits before RPC readiness", async () => {
    await expect(
      PiProcess.start({
        executable: processExecutable(),
        argvPrefix: [scriptedPiPath],
        piArgv: [],
        cwd: tmpdir(),
        env: { PIFLEET_TEST_PI_MODE: "exit-before-ready" },
      }),
    ).rejects.toThrow();
  });

  it("does not expose bounded Pi stderr in timeout errors", async () => {
    const pi = await rejectsPrompt("timeout");
    await expect(pi.request({ type: "prompt", message: "secret" }, 20)).rejects.toThrow(
      /^Pi RPC request timed out$/,
    );
  });

  it.each(["split", "coalesced", "duplicate"])(
    "accepts %s response framing without leaving a pending request",
    async (mode) => {
      const pi = await rejectsPrompt(mode);
      await expect(pi.request({ type: "prompt", message: "hello" }, 500)).resolves.toMatchObject({
        success: true,
      });
    },
  );

  it.each(["malformed", "invalid-utf8", "partial", "exit"])(
    "terminates requests after %s Pi output/exit",
    async (mode) => {
      const pi = await rejectsPrompt(mode);
      await expect(within(pi.request({ type: "prompt" }, 1_000), 2_000)).rejects.toThrow();
    },
  );

  it("ignores an unmatched response and terminates at the request deadline", async () => {
    const pi = await rejectsPrompt("unknown");
    await expect(pi.request({ type: "prompt" }, 20)).rejects.toThrow(/^Pi RPC request timed out$/);
  });

  it("terminates requests after an oversized Pi frame", async () => {
    const pi = await rejectsPrompt("oversized", { maxFrameBytes: 1_024 });
    await expect(within(pi.request({ type: "prompt" }, 1_000), 2_000)).rejects.toThrow();
  });
});

describe("public error redaction", () => {
  it("does not expose a Pi startup exception through the create result", async () => {
    const canary = "PRIVATE_PI_ARG_ENV_STDERR_STACK";
    const launcher: PiLauncher = {
      artifactId: "failing-pi",
      async start() {
        throw new Error(canary);
      },
    };
    const service = new FleetService(new MemoryFleetStore(), { launcher });
    const result = await service.create(
      { name: "redacted", cwd: "/private/project", piArgv: ["--secret", canary] },
      "create-redacted",
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "pi_start_failed", message: "Pi failed to start." },
    });
    expect(JSON.stringify(result)).not.toContain(canary);
    await service.close();
  });

  it("normalizes an unexpected runtime startup failure without leaking its message", async () => {
    const root = await mkdtemp(join(tmpdir(), "pifleet-redaction-"));
    const socketPath = join(root, "control.sock");
    const canary = "PRIVATE_MESSAGE_API_KEY_SESSION_STACK";
    const throwingService = {
      async list() {
        throw new Error(canary);
      },
    } as unknown as FleetService;
    const server: ControlServer = await startControlServer({
      socketPath,
      service: throwingService,
    });
    cleanups.push(async () => {
      await server.close();
      await rm(root, { recursive: true, force: true });
    });
    const client = new SocketFleetClient({ socketPath });

    const result = await client.list({ signal: new AbortController().signal });
    expect(result).toEqual({
      ok: false,
      error: {
        code: "internal_error",
        message: "pi-fleet encountered an internal error.",
      },
    });
    expect(JSON.stringify(result)).not.toContain(canary);
  });
});
