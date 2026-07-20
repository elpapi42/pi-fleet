import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { verifyRuntime } from "../../src/platform/install/runtime-release.js";
import { PRODUCT_VERSION } from "../../src/shared/product-identity.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function stopMaterializedRuntime(applicationRoot: string): Promise<void> {
  if (process.platform !== "linux") return;
  const pattern = join(applicationRoot, "releases");
  const findPids = async (): Promise<number[]> => {
    const result = await execFileAsync("pgrep", ["-f", pattern]).catch(() => ({ stdout: "" }));
    return result.stdout
      .trim()
      .split("\n")
      .filter((value) => value.length > 0)
      .map(Number)
      .filter((pid) => Number.isSafeInteger(pid) && pid !== process.pid);
  };
  for (const pid of await findPids()) process.kill(pid, "SIGTERM");
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ((await findPids()).length === 0) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  for (const pid of await findPids()) process.kill(pid, "SIGKILL");
}

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
  it("installs the npm tarball and runs a materialized closure after removing the installation", async () => {
    const root = await mkdtemp(join(tmpdir(), "pifleet-release-"));
    roots.push(root);
    const packDirectory = join(root, "pack");
    const prefix = join(root, "prefix");
    await mkdir(packDirectory);
    const packed = await execFileAsync(
      "npm",
      ["pack", "--json", "--pack-destination", packDirectory],
      { cwd: resolve(".") },
    );
    const packReport = JSON.parse(packed.stdout) as Array<{ filename: string }>;
    const tarball = join(packDirectory, packReport[0]?.filename ?? "missing.tgz");
    await execFileAsync(
      "npm",
      ["install", "--global", "--prefix", prefix, "--ignore-scripts", tarball],
      { cwd: root },
    );
    const installedRoot = join(prefix, "lib", "node_modules", "@elpapi42", "pi-fleet");
    const installedBin = join(prefix, "bin", "pifleet");
    const installedVersion = await execFileAsync(installedBin, ["--version"], { cwd: root });
    expect(installedVersion.stdout).toBe(`${PRODUCT_VERSION}\n`);
    const installedClosureDifference = join(
      installedRoot,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "pifleet-install-layout-difference.txt",
    );
    await writeFile(installedClosureDifference, "legitimate installed closure difference\n");

    const applicationRoot = join(root, "application");
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
    const clientEnv = {
      ...process.env,
      PIFLEET_APPLICATION_ROOT: applicationRoot,
      PIFLEET_STATE_ROOT: stateRoot,
      PIFLEET_DISABLE_REGISTERED_SERVICE: "1",
      PI_CODING_AGENT_DIR: agentDir,
    };
    let release = "";
    let cliPath = "";
    try {
      const initialList = await execFileAsync(installedBin, ["list"], {
        cwd: root,
        env: clientEnv,
      });
      expect(JSON.parse(initialList.stdout)).toMatchObject({ type: "agent.list", agents: [] });

      const created = await execFileAsync(
        installedBin,
        [
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

      const releases = await readdir(join(applicationRoot, "releases"));
      expect(releases).toHaveLength(1);
      release = join(applicationRoot, "releases", releases[0] ?? "missing");
      cliPath = join(release, "bin", "pifleet.mjs");
      await expect(
        readFile(
          join(
            release,
            "node_modules",
            "@earendil-works",
            "pi-coding-agent",
            "pifleet-install-layout-difference.txt",
          ),
          "utf8",
        ),
      ).resolves.toBe("legitimate installed closure difference\n");
      await expect(
        (await import("node:fs/promises")).lstat(release).then((entry) => entry.mode & 0o777),
      ).resolves.toBe(0o700);
      await rm(installedRoot, { recursive: true, force: true });
      const output = await execFileAsync(process.execPath, [cliPath, "--version"], { cwd: root });
      expect(output.stdout).toBe(`${PRODUCT_VERSION}\n`);
      await stopMaterializedRuntime(applicationRoot);
      const restartedList = await execFileAsync(process.execPath, [cliPath, "list"], {
        cwd: root,
        env: clientEnv,
      });
      expect(JSON.parse(restartedList.stdout)).toMatchObject({
        type: "agent.list",
        agents: [{ name: "packaged-agent" }],
      });

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
      await stopMaterializedRuntime(applicationRoot);
      await model.close();
    }

    const dependencyPath = join(release, "node_modules", "commander", "package.json");
    const dependencyContents = await readFile(dependencyPath, "utf8");
    await writeFile(dependencyPath, `${dependencyContents}\n`);
    await expect(verifyRuntime(release)).rejects.toThrow(/dependency closure/i);
    await writeFile(dependencyPath, dependencyContents);
    await verifyRuntime(release);

    const runtimePath = join(release, "dist", "runtime.mjs");
    await writeFile(runtimePath, `${await readFile(runtimePath, "utf8")}\n// corruption\n`);
    await expect(verifyRuntime(release)).rejects.toThrow(/changed|verification/i);
  }, 120_000);

  it("packs only the declared public artifact surface", async () => {
    const result = await execFileAsync("npm", ["pack", "--dry-run", "--json"], {
      cwd: resolve("."),
    });
    const report = JSON.parse(result.stdout) as Array<{ files: Array<{ path: string }> }>;
    const paths = report[0]?.files.map((file) => file.path) ?? [];

    expect(paths).toContain("bin/pifleet.mjs");
    expect(paths).toContain("bin/pifleet-runtime.mjs");
    expect(paths).toContain("dist/runtime.mjs");
    expect(paths).toContain("dist/sqlite-worker.mjs");
    expect(paths).toContain("dist/runtime-manifest.json");
    expect(paths.some((path) => path.startsWith("research/") || path.startsWith("pi/"))).toBe(
      false,
    );
  });
});
