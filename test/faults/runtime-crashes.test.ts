import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { SocketFleetClient } from "../../src/client/socket-fleet-client.js";
import { resolveFleetPaths } from "../../src/platform/shared/paths.js";

interface RunningRuntime {
  readonly child: ChildProcess;
  stop(): Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.allSettled(
    cleanups
      .splice(0)
      .reverse()
      .map((cleanup) => cleanup()),
  );
});

async function waitUntil(check: () => Promise<boolean>, milliseconds = 5_000): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  throw new Error("condition did not become true");
}

async function startRuntime(env: NodeJS.ProcessEnv): Promise<RunningRuntime> {
  const child = spawn(process.execPath, [resolve("dist/runtime.mjs")], {
    env,
    detached: true,
    stdio: "ignore",
  });
  const client = new SocketFleetClient({ socketPath: resolveFleetPaths(env).socketPath });
  await waitUntil(async () => (await client.list({ signal: new AbortController().signal })).ok);
  return {
    child,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      await once(child, "exit");
    },
  };
}

function activePiPid(databasePath: string): number | null {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database
      .prepare(
        "SELECT pid FROM incarnations WHERE state IN ('starting','live','stopping','cleanup_uncertain') ORDER BY rowid DESC LIMIT 1",
      )
      .get() as { pid: number | null } | undefined;
    return row?.pid ?? null;
  } finally {
    database.close();
  }
}

describe("compiled runtime crash recovery", () => {
  it("fails held clients, preserves the session, and never starts a second writer after SIGKILL", async () => {
    const root = await mkdtemp(join(tmpdir(), "pifleet-runtime-crash-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const wrapper = join(root, "scripted-pi");
    const fixture = new URL("../fixtures/scripted-pi.mjs", import.meta.url).pathname;
    await writeFile(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`);
    await chmod(wrapper, 0o700);
    const sessionPath = join(root, "user-session.jsonl");
    await writeFile(sessionPath, '{"type":"session","id":"user-owned"}\n');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: root,
      PIFLEET_STATE_ROOT: join(root, "state"),
      PIFLEET_APPLICATION_ROOT: join(root, "application"),
      PIFLEET_DISABLE_REGISTERED_SERVICE: "1",
      PIFLEET_PI_EXECUTABLE: wrapper,
      PIFLEET_PI_ARTIFACT_ID: "scripted-pi",
      PIFLEET_TEST_PI_MODE: "working",
      PIFLEET_TEST_SESSION_PATH: sessionPath,
    };
    const paths = resolveFleetPaths(env);
    const first = await startRuntime(env);
    cleanups.push(() => first.stop());
    const client = new SocketFleetClient({ socketPath: paths.socketPath });
    const signal = new AbortController().signal;
    await expect(
      client.create(
        { name: "crash", cwd: root, piArgv: ["--session", sessionPath] },
        {
          signal,
          operation: { operationId: "create-crash", createdAt: new Date().toISOString() },
        },
      ),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      client.send(
        { name: "crash", message: "keep working" },
        {
          signal,
          operation: { operationId: "send-crash", createdAt: new Date().toISOString() },
        },
      ),
    ).resolves.toMatchObject({ ok: true });
    const receiving = client.receive({ name: "crash" }, { signal, timeoutMs: 10_000 });
    const originalPiPid = activePiPid(paths.databasePath);
    expect(originalPiPid).not.toBeNull();

    first.child.kill("SIGKILL");
    await once(first.child, "exit");
    await expect(receiving).resolves.toMatchObject({
      ok: false,
      error: { code: "runtime_unavailable" },
    });

    const second = await startRuntime(env);
    cleanups.push(() => second.stop());
    const recoveredClient = new SocketFleetClient({ socketPath: paths.socketPath });
    await expect(recoveredClient.status({ name: "crash" }, { signal })).resolves.toMatchObject({
      ok: true,
      value: {
        agent: {
          state: "failed",
          process: { state: "absent" },
        },
      },
    });
    expect(activePiPid(paths.databasePath)).toBeNull();
    await expect(readFile(sessionPath, "utf8")).resolves.toBe(
      '{"type":"session","id":"user-owned"}\n',
    );
  });
});
