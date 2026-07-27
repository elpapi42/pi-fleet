import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { SemanticEvent } from "../../src/client/contracts.js";
import { RealPiLauncher } from "../../src/pi/adapter.js";
import { FleetService } from "../../src/runtime/fleet-service.js";
import { JournalRuntimeComposition } from "../../src/runtime/journal-runtime.js";
import { JournalWakeup } from "../../src/runtime/journal-wakeup.js";
import { OpaqueReceiveCursorCodec } from "../../src/runtime/receive-pager.js";
import { DEFAULT_RUNTIME_LIMITS } from "../../src/shared/runtime-limits.js";
import { JournalFleetStoreAdapter } from "../../src/store/journal-fleet-store-adapter.js";
import { MemoryJournalStore } from "../../src/store/memory-journal-store.js";

/**
 * Protocol-v3 lifecycle proof against the separately installed external Pi.
 *
 * These cases replace the removed finite-receive and raw-watch suite: they prove
 * semantic receive delivery, steering, follow-up delivery, native-session
 * restoration with one writer, no replay after active interruption, headless
 * extension-UI cancellation, and preservation of user-owned session files.
 */
const SELECTED_PI_EXECUTABLE =
  process.env.PIFLEET_PI_EXECUTABLE ?? resolve(process.cwd(), "node_modules", ".bin", "pi");

const PI_ARGV = [
  "--provider",
  "pifleet-probe",
  "--model",
  "deterministic",
  "--no-skills",
  "--no-prompt-templates",
  "--no-tools",
];

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function deterministicProvider(responseDelayMs = 0) {
  let requestCount = 0;
  const bodies: string[] = [];
  let started!: () => void;
  const firstRequestStarted = new Promise<void>((resolveStarted) => (started = resolveStarted));
  const server = createServer(async (request, response) => {
    let body = "";
    request.setEncoding("utf8");
    for await (const chunk of request) body += chunk;
    bodies.push(body);
    requestCount += 1;
    started();
    if (responseDelayMs > 0) await new Promise((wait) => setTimeout(wait, responseDelayMs));
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
      `data: ${JSON.stringify(
        frame({ content: `deterministic response ${String(requestCount)}` }, null),
      )}\n\n`,
    );
    response.write(`data: ${JSON.stringify(frame({}, "stop"))}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolveListen) => server.once("listening", resolveListen));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("provider failed to listen");
  cleanups.push(
    () =>
      new Promise<void>((resolveClose, rejectClose) =>
        server.close((error) => (error === undefined ? resolveClose() : rejectClose(error))),
      ),
  );
  return { port: address.port, bodies, count: () => requestCount, firstRequestStarted };
}

async function environment(prefix: string, extensions = false, responseDelayMs = 0) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project");
  const agentDir = join(root, "pi-agent");
  await mkdir(project, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  const provider = await deterministicProvider(responseDelayMs);
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "pifleet-probe": {
          baseUrl: `http://127.0.0.1:${String(provider.port)}/v1`,
          api: "openai-completions",
          apiKey: "local-placeholder",
          models: [{ id: "deterministic", contextWindow: 4096, maxTokens: 256 }],
        },
      },
    }),
  );
  const pids: number[] = [];
  const store = new MemoryJournalStore();
  const service = new FleetService(new JournalFleetStoreAdapter(store), {
    launcher: new RealPiLauncher({
      executable: SELECTED_PI_EXECUTABLE,
      artifactId: "external-pi",
      env: { PI_CODING_AGENT_DIR: agentDir },
      onStart: (pid) => pids.push(pid),
    }),
    journal: new JournalRuntimeComposition({
      store,
      limits: DEFAULT_RUNTIME_LIMITS,
      cursors: new OpaqueReceiveCursorCodec(),
      wakeup: new JournalWakeup(),
    }),
    journalStore: store,
  });
  cleanups.push(() => service.close());
  const piArgv = extensions
    ? PI_ARGV.filter((argument) => argument !== "--no-tools")
    : ["--no-extensions", ...PI_ARGV];
  return { project, agentDir, provider, pids, service, piArgv };
}

async function attachReceive(service: FleetService, name: string, expectedAgentId: string) {
  const abort = new AbortController();
  cleanups.push(async () => abort.abort());
  const prepared = await service.prepareReceive(
    { name, expectedAgentId },
    { kind: "live" },
    false,
    abort.signal,
  );
  if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));
  const iterator = prepared.value.stream[Symbol.asyncIterator]();
  return {
    cursor: prepared.value.stream.cursor,
    async until(match: (event: SemanticEvent) => boolean): Promise<SemanticEvent[]> {
      const observed: SemanticEvent[] = [];
      while (observed.length < 50) {
        const next = await iterator.next();
        if (next.done === true) throw new Error("receive stream ended before the expected event");
        observed.push(next.value);
        if (match(next.value)) return observed;
      }
      throw new Error("expected receive event was not observed");
    },
  };
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error("condition did not become true");
}

async function agentSession(service: FleetService, name: string) {
  const status = await service.status({ name });
  if (!status.ok || status.value.agent.session.path === null) {
    throw new Error("external Pi did not materialize a session");
  }
  return status.value.agent.session;
}

describe("real Pi protocol-v3 lifecycle", () => {
  it("streams semantic activity, steers, follows up, and restores the same native session", async () => {
    const { project, provider, pids, service, piArgv } = await environment("pifleet-real-pi-");

    const created = await service.create({ name: "reviewer", cwd: project, piArgv }, "create-1");
    if (!created.ok) throw new Error(JSON.stringify(created.error));
    expect(created.value.agent).toMatchObject({
      state: "idle",
      process: { state: "resident" },
    });
    const agentId = created.value.agent.id;
    expect(pids).toHaveLength(1);

    const receive = await attachReceive(service, "reviewer", agentId);
    expect(typeof receive.cursor).toBe("string");

    expect(
      await service.send(
        { name: "reviewer", expectedAgentId: agentId, message: "first" },
        "send-1",
      ),
    ).toMatchObject({ ok: true });

    const firstTurn = await receive.until(
      (event) =>
        event.type === "assistant.message.finished" && event.text === "deterministic response 1",
    );
    expect(firstTurn.map((event) => event.type)).toContain("assistant.message.started");
    expect(new Set(firstTurn.map((event) => event.agentId))).toEqual(new Set([agentId]));
    const started = firstTurn.find((event) => event.type === "assistant.message.started");
    const finished = firstTurn.at(-1);
    expect(started?.activityId).toBe(finished?.activityId);
    expect(new Set(firstTurn.map((event) => event.cursor)).size).toBe(firstTurn.length);

    expect(
      await service.send(
        { name: "reviewer", expectedAgentId: agentId, message: "second" },
        "send-2",
      ),
    ).toMatchObject({ ok: true });
    await receive.until(
      (event) =>
        event.type === "assistant.message.finished" && event.text === "deterministic response 2",
    );
    expect(pids).toHaveLength(1);

    const session = await agentSession(service, "reviewer");
    await service.releaseAgentProcess("reviewer");
    expect(await service.status({ name: "reviewer" })).toMatchObject({
      ok: true,
      value: { agent: { state: "idle", process: { state: "absent" } } },
    });

    expect(
      await service.send(
        { name: "reviewer", expectedAgentId: agentId, message: "third" },
        "send-3",
      ),
    ).toMatchObject({ ok: true });
    await waitUntil(async () => {
      const status = await service.status({ name: "reviewer" });
      return status.ok && status.value.agent.process.state === "resident";
    });
    expect(pids).toHaveLength(2);
    expect(await agentSession(service, "reviewer")).toEqual(session);
    expect(provider.bodies.at(-1)).toContain("deterministic response 2");

    expect(
      await service.destroy({ name: "reviewer", expectedAgentId: agentId }, "destroy-1"),
    ).toMatchObject({ ok: true });
    await expect(readFile(session.path!, "utf8")).resolves.toContain("deterministic response 1");
  }, 60_000);

  it("delivers follow-up input queued while Pi is genuinely working", async () => {
    const { project, service, piArgv, provider } = await environment(
      "pifleet-real-pi-followup-",
      false,
      1_500,
    );

    const created = await service.create({ name: "reviewer", cwd: project, piArgv }, "create-1");
    if (!created.ok) throw new Error(JSON.stringify(created.error));
    const agentId = created.value.agent.id;
    const receive = await attachReceive(service, "reviewer", agentId);

    await service.send({ name: "reviewer", expectedAgentId: agentId, message: "first" }, "send-1");
    await provider.firstRequestStarted;
    expect(
      await service.send(
        {
          name: "reviewer",
          expectedAgentId: agentId,
          message: "queued while working",
          delivery: "followUp",
        },
        "send-2",
      ),
    ).toMatchObject({ ok: true });

    await receive.until(
      (event) =>
        event.type === "assistant.message.finished" && event.text === "deterministic response 2",
    );
    expect(provider.bodies.at(-1)).toContain("queued while working");
    await service.destroy({ name: "reviewer", expectedAgentId: agentId }, "destroy-1");
  }, 60_000);

  it("fails active work without replay when the selected Pi process dies", async () => {
    const { project, provider, pids, service, piArgv } = await environment("pifleet-real-pi-kill-");

    const created = await service.create({ name: "reviewer", cwd: project, piArgv }, "create-1");
    if (!created.ok) throw new Error(JSON.stringify(created.error));
    const agentId = created.value.agent.id;
    await service.send({ name: "reviewer", expectedAgentId: agentId, message: "one" }, "send-1");
    const receive = await attachReceive(service, "reviewer", agentId);
    await service.send({ name: "reviewer", expectedAgentId: agentId, message: "two" }, "send-2");
    await receive.until((event) => event.type === "assistant.message.finished");
    const session = await agentSession(service, "reviewer");
    const requestsBefore = provider.count();
    const firstPid = pids[0]!;

    process.kill(firstPid, "SIGKILL");
    await waitUntil(async () => {
      const status = await service.status({ name: "reviewer" });
      return (
        status.ok &&
        status.value.agent.state === "failed" &&
        status.value.agent.process.state === "absent"
      );
    });
    expect(pids).toEqual([firstPid]);
    expect(provider.count()).toBe(requestsBefore);

    expect(
      await service.send(
        { name: "reviewer", expectedAgentId: agentId, message: "after" },
        "send-3",
      ),
    ).toMatchObject({ ok: true });
    await waitUntil(async () => {
      const status = await service.status({ name: "reviewer" });
      return status.ok && status.value.agent.process.state === "resident";
    });
    expect(pids).toHaveLength(2);
    expect(await agentSession(service, "reviewer")).toEqual(session);

    await service.destroy({ name: "reviewer", expectedAgentId: agentId }, "destroy-1");
    await expect(readFile(session.path!, "utf8")).resolves.toContain("deterministic response");
  }, 60_000);

  it("cancels blocking extension UI headlessly without invoking the provider", async () => {
    const { project, provider, service } = await environment("pifleet-real-pi-extension-", true);
    const selectedPiTarget = await realpath(SELECTED_PI_EXECUTABLE);
    const extensionPath = join(
      dirname(dirname(selectedPiTarget)),
      "examples",
      "extensions",
      "rpc-demo.ts",
    );
    const piArgv = [...PI_ARGV, "--extension", extensionPath];

    const created = await service.create({ name: "reviewer", cwd: project, piArgv }, "create-1");
    if (!created.ok) throw new Error(JSON.stringify(created.error));
    const agentId = created.value.agent.id;

    expect(
      await service.send(
        { name: "reviewer", expectedAgentId: agentId, message: "/rpc-input" },
        "send-ui",
      ),
    ).toMatchObject({ ok: true });
    await waitUntil(async () => {
      const status = await service.status({ name: "reviewer" });
      return status.ok && status.value.agent.state === "idle";
    });

    // Blocking extension UI is cancelled headlessly, so no provider turn happens.
    expect(provider.count()).toBe(0);
    await service.destroy({ name: "reviewer", expectedAgentId: agentId }, "destroy-1");
  }, 60_000);
});
