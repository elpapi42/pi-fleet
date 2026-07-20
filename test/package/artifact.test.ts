import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { materializeRuntime, verifyRuntime } from "../../src/platform/install/runtime-release.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function startDeterministicModel(): Promise<{
  readonly port: number;
  close(): Promise<void>;
}> {
  let requestCount = 0;
  const server = createServer(async (request, response) => {
    request.resume();
    await once(request, "end");
    requestCount += 1;
    response.writeHead(200, { "content-type": "text/event-stream" });
    const frame = (delta: Record<string, unknown>, finish: string | null) => ({
      id: `response-${String(requestCount)}`,
      object: "chat.completion.chunk",
      created: 1,
      model: "deterministic",
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
    response.write(`data: ${JSON.stringify(frame({ role: "assistant" }, null))}\n\n`);
    response.write(
      `data: ${JSON.stringify(frame({ content: `packaged response ${String(requestCount)}` }, null))}\n\n`,
    );
    response.write(`data: ${JSON.stringify(frame({}, "stop"))}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("model server failed");
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolveClose, rejectClose) =>
        server.close((error) => (error === undefined ? resolveClose() : rejectClose(error))),
      ),
  };
}

describe("packed and materialized runtime", () => {
  it("materializes a verified private closure that runs away from the source cwd", async () => {
    const root = await mkdtemp(join(tmpdir(), "pifleet-release-"));
    roots.push(root);
    const release = await materializeRuntime({
      sourceRoot: resolve("."),
      applicationRoot: join(root, "application"),
    });

    const output = await execFileAsync(
      process.execPath,
      [join(release, "bin", "pifleet.mjs"), "--version"],
      {
        cwd: root,
      },
    );
    expect(output.stdout).toBe("0.0.0-development\n");
    expect(
      (await import("node:fs/promises")).lstat(release).then((entry) => entry.mode & 0o777),
    ).resolves.toBe(0o700);

    const stateRoot = join(root, "state");
    const project = join(root, "project");
    const agentDir = join(root, "pi-agent");
    const sessionPath = join(root, "user-session.jsonl");
    await mkdir(project);
    await mkdir(agentDir);
    const model = await startDeterministicModel();
    await writeFile(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          "pifleet-package": {
            baseUrl: `http://127.0.0.1:${String(model.port)}/v1`,
            api: "openai-completions",
            apiKey: "local-placeholder",
            models: [{ id: "deterministic", contextWindow: 4096, maxTokens: 256 }],
          },
        },
      }),
    );
    await writeFile(
      sessionPath,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "01901234-5678-7abc-8def-0123456789ab",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: project,
      })}\n`,
    );
    const runtimePath = join(release, "dist", "runtime.mjs");
    const cliPath = join(release, "bin", "pifleet.mjs");
    const clientEnv = { ...process.env, PIFLEET_STATE_ROOT: stateRoot };
    const runtime = spawn(process.execPath, [runtimePath], {
      env: { ...clientEnv, PI_CODING_AGENT_DIR: agentDir },
      stdio: "ignore",
    });
    try {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (
          await access(join(stateRoot, "control.sock")).then(
            () => true,
            () => false,
          )
        )
          break;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      }
      await access(join(stateRoot, "control.sock"));
      const created = await execFileAsync(
        process.execPath,
        [
          cliPath,
          "create",
          "packaged-agent",
          "--cwd",
          project,
          "--",
          "--session",
          sessionPath,
          "--provider",
          "pifleet-package",
          "--model",
          "deterministic",
          "--no-extensions",
          "--no-skills",
          "--no-prompt-templates",
          "--no-tools",
        ],
        { cwd: root, env: clientEnv },
      );
      expect(JSON.parse(created.stdout)).toMatchObject({ type: "agent.created" });

      const watch = spawn(process.execPath, [cliPath, "watch", "packaged-agent"], {
        cwd: root,
        env: clientEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let watched = "";
      let watchError = "";
      watch.stdout.setEncoding("utf8").on("data", (chunk: string) => (watched += chunk));
      watch.stderr.setEncoding("utf8").on("data", (chunk: string) => (watchError += chunk));
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));

      const sent = await execFileAsync(
        process.execPath,
        [cliPath, "send", "packaged-agent", "hello from the packaged CLI"],
        { cwd: root, env: clientEnv },
      );
      expect(JSON.parse(sent.stdout)).toMatchObject({ type: "message.accepted" });
      const received = await execFileAsync(
        process.execPath,
        [cliPath, "receive", "packaged-agent", "--human"],
        { cwd: root, env: clientEnv },
      );
      expect(received.stdout).toBe("packaged response 1\n");
      const status = await execFileAsync(process.execPath, [cliPath, "status", "packaged-agent"], {
        cwd: root,
        env: clientEnv,
      });
      expect(JSON.parse(status.stdout)).toMatchObject({ type: "agent.status" });
      const listed = await execFileAsync(process.execPath, [cliPath, "list"], {
        cwd: root,
        env: clientEnv,
      });
      expect(JSON.parse(listed.stdout)).toMatchObject({
        type: "agent.list",
        agents: [{ name: "packaged-agent" }],
      });

      for (
        let attempt = 0;
        attempt < 200 && !watched.includes("packaged response 1");
        attempt += 1
      ) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      }
      expect(watched, watchError).toContain("packaged response 1");

      await execFileAsync(process.execPath, [cliPath, "destroy", "packaged-agent"], {
        cwd: root,
        env: clientEnv,
      });
      if (watch.exitCode === null) {
        await Promise.race([
          once(watch, "exit"),
          new Promise<never>((_resolve, reject) =>
            setTimeout(() => reject(new Error(`watch did not close: ${watchError}`)), 2_000),
          ),
        ]);
      }
      expect(watch.exitCode).toBe(0);
      await expect(readFile(sessionPath, "utf8")).resolves.toContain("packaged response 1");
    } finally {
      if (runtime.exitCode === null) {
        runtime.kill("SIGTERM");
        await new Promise((resolveExit) => runtime.once("exit", resolveExit));
      }
      await model.close();
    }

    await writeFile(runtimePath, `${await readFile(runtimePath, "utf8")}\n// corruption\n`);
    await writeFile(runtimePath, `${await readFile(runtimePath, "utf8")}\n// corruption\n`);
    await expect(verifyRuntime(release)).rejects.toThrow(/changed|verification/i);
  }, 60_000);

  it("packs only the declared public artifact surface", async () => {
    const result = await execFileAsync("npm", ["pack", "--dry-run", "--json"], {
      cwd: resolve("."),
    });
    const report = JSON.parse(result.stdout) as Array<{ files: Array<{ path: string }> }>;
    const paths = report[0]?.files.map((file) => file.path) ?? [];

    expect(paths).toContain("bin/pifleet.mjs");
    expect(paths).toContain("dist/runtime.mjs");
    expect(paths).toContain("dist/sqlite-worker.mjs");
    expect(paths).toContain("dist/runtime-manifest.json");
    expect(paths.some((path) => path.startsWith("research/") || path.startsWith("pi/"))).toBe(
      false,
    );
  });
});
