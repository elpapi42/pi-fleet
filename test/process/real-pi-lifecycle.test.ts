import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { RealPiLauncher } from "../../src/pi/adapter.js";
import { FleetService } from "../../src/runtime/fleet-service.js";
import { MemoryFleetStore } from "../../src/store/memory-store.js";
import { SqliteFleetStore } from "../../src/store/sqlite-store.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function deterministicServer() {
  let requestCount = 0;
  const bodies: string[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    request.setEncoding("utf8");
    for await (const chunk of request) body += chunk;
    bodies.push(body);
    requestCount += 1;
    response.writeHead(200, { "content-type": "text/event-stream" });
    const frame = (delta: Record<string, unknown>, finish: string | null) => ({
      id: `response-${requestCount}`,
      object: "chat.completion.chunk",
      created: 1,
      model: "deterministic",
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
    response.write(`data: ${JSON.stringify(frame({ role: "assistant" }, null))}\n\n`);
    response.write(
      `data: ${JSON.stringify(frame({ content: `deterministic response ${requestCount}` }, null))}\n\n`,
    );
    response.write(`data: ${JSON.stringify(frame({}, "stop"))}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolveListen) => server.once("listening", resolveListen));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server failed to listen");
  cleanups.push(
    () =>
      new Promise<void>((resolveClose, rejectClose) =>
        server.close((error) => (error === undefined ? resolveClose() : rejectClose(error))),
      ),
  );
  return { port: address.port, bodies, count: () => requestCount };
}

describe("real Pi in-memory lifecycle", () => {
  it("creates, reuses, releases, and restores the same native session", async () => {
    const root = await mkdtemp(join(tmpdir(), "pifleet-real-pi-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const project = join(root, "project");
    const agentDir = join(root, "pi-agent");
    await mkdir(project, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    const model = await deterministicServer();
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({ compaction: { reserveTokens: 100, keepRecentTokens: 10 } }),
    );
    await writeFile(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          "pifleet-probe": {
            baseUrl: `http://127.0.0.1:${model.port}/v1`,
            api: "openai-completions",
            apiKey: "local-placeholder",
            models: [{ id: "deterministic", contextWindow: 4096, maxTokens: 256 }],
          },
        },
      }),
    );

    const pids: number[] = [];
    const launcher = new RealPiLauncher({
      executable: "pi",
      artifactId: "pi@0.80.10",
      env: { PI_CODING_AGENT_DIR: agentDir },
      onStart: (pid) => pids.push(pid),
    });
    const service = new FleetService(new MemoryFleetStore(), {
      launcher,
      now: () => "2026-01-01T00:00:00.000Z",
    });
    cleanups.push(() => service.close());
    const piArgv = [
      "--provider",
      "pifleet-probe",
      "--model",
      "deterministic",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-tools",
    ];

    const created = await service.create({ name: "reviewer", cwd: project, piArgv }, "create-1");
    expect(created).toMatchObject({
      ok: true,
      value: {
        agent: {
          state: "idle",
          process: { state: "resident" },
          session: { path: expect.stringContaining(".jsonl"), id: expect.any(String) },
        },
      },
    });
    expect(pids).toHaveLength(1);

    await service.send({ name: "reviewer", message: "first" }, "send-1");
    expect(await service.receive({ name: "reviewer" })).toMatchObject({
      ok: true,
      value: { response: { text: "deterministic response 1" } },
    });
    await service.send({ name: "reviewer", message: "second" }, "send-2");
    expect(await service.receive({ name: "reviewer" })).toMatchObject({
      ok: true,
      value: { response: { text: "deterministic response 2" } },
    });
    expect(pids).toHaveLength(1);

    const compacted = await service.compact({ name: "reviewer" }, "compact-1");
    if (!compacted.ok) throw new Error(JSON.stringify(compacted.error));
    expect(compacted).toMatchObject({
      ok: true,
      value: {
        type: "agent.compacted",
        compaction: {
          tokensBefore: expect.any(Number),
          estimatedTokensAfter: expect.any(Number),
        },
      },
    });
    expect(model.count()).toBe(3);

    const status = await service.status({ name: "reviewer" });
    if (!status.ok || status.value.agent.session.path === null) throw new Error("missing session");
    const sessionPath = status.value.agent.session.path;
    expect(await readFile(sessionPath, "utf8")).toContain('"type":"compaction"');

    await service.releaseAgentProcess("reviewer");
    expect(await service.status({ name: "reviewer" })).toMatchObject({
      ok: true,
      value: { agent: { state: "idle", process: { state: "absent" } } },
    });

    await service.send({ name: "reviewer", message: "third" }, "send-3");
    expect(await service.receive({ name: "reviewer" })).toMatchObject({
      ok: true,
      value: { response: { text: "deterministic response 4" } },
    });
    expect(pids).toHaveLength(2);
    expect(model.bodies.at(-1)).toContain("deterministic response 3");

    expect(await service.destroy({ name: "reviewer" }, "destroy-1")).toMatchObject({
      ok: true,
    });
    await expect(readFile(sessionPath, "utf8")).resolves.toContain("deterministic response 4");
  }, 30_000);

  it("persists the latest response and restores only when addressed after runtime restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "pifleet-real-pi-restart-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const project = join(root, "project");
    const agentDir = join(root, "pi-agent");
    await mkdir(project, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    const model = await deterministicServer();
    await writeFile(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          "pifleet-probe": {
            baseUrl: `http://127.0.0.1:${model.port}/v1`,
            api: "openai-completions",
            apiKey: "local-placeholder",
            models: [{ id: "deterministic", contextWindow: 4096, maxTokens: 256 }],
          },
        },
      }),
    );
    const pids: number[] = [];
    const launcher = () =>
      new RealPiLauncher({
        executable: "pi",
        artifactId: "pi@0.80.10",
        env: { PI_CODING_AGENT_DIR: agentDir },
        onStart: (pid) => pids.push(pid),
      });
    const piArgv = [
      "--provider",
      "pifleet-probe",
      "--model",
      "deterministic",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-tools",
    ];
    const databasePath = join(root, "fleet.sqlite");
    const firstStore = new SqliteFleetStore(databasePath);
    const firstService = new FleetService(firstStore, { launcher: launcher() });
    await firstService.create({ name: "reviewer", cwd: project, piArgv }, "create-1");
    await firstService.send({ name: "reviewer", message: "first" }, "send-1");
    expect(await firstService.receive({ name: "reviewer" })).toMatchObject({
      ok: true,
      value: { response: { text: "deterministic response 1" } },
    });
    await firstService.close();
    await firstStore.close(true);

    const secondStore = new SqliteFleetStore(databasePath);
    const secondService = new FleetService(secondStore, { launcher: launcher() });
    cleanups.push(async () => {
      await secondService.close();
      await secondStore.close(true);
    });
    expect(await secondService.status({ name: "reviewer" })).toMatchObject({
      ok: true,
      value: { agent: { state: "idle", process: { state: "absent" } } },
    });
    expect(await secondService.receive({ name: "reviewer" })).toMatchObject({
      ok: true,
      value: { response: { text: "deterministic response 1" } },
    });
    expect(pids).toHaveLength(1);

    await secondService.send({ name: "reviewer", message: "second" }, "send-2");
    expect(await secondService.receive({ name: "reviewer" })).toMatchObject({
      ok: true,
      value: { response: { text: "deterministic response 2" } },
    });
    expect(pids).toHaveLength(2);
    await secondService.destroy({ name: "reviewer" }, "destroy-1");
  }, 30_000);
});
