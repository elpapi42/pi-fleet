import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";

import type {
  FleetClient,
  FleetClientError,
  MutationOptions,
} from "../../src/client/fleet-client.js";
import { createPiFleetClient } from "../../src/client/sdk-facade.js";
import { FleetClientSdkTransport } from "../../src/client/sdk-transport.js";
import { runCli, type CliDependencies } from "../../src/entry/cli.js";
import { err, ok } from "../../src/shared/result.js";

function writable(capture: (chunk: string) => void): Writable {
  return new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      capture(chunk.toString());
      callback();
    },
  });
}

function createHarness(client: FleetClient, stdinText = "") {
  let stdout = "";
  let stderr = "";
  let operation = 0;
  const operationIds = () => ({
    operationId: `operation-${++operation}`,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const dependencies: CliDependencies = {
    client: createPiFleetClient(
      new FleetClientSdkTransport(client, operationIds, { reconnectDelayMs: 0 }),
    ),
    cwd: "/workspace",
    stdin: Readable.from([stdinText]),
    stdout: writable((chunk) => (stdout += chunk)),
    stderr: writable((chunk) => (stderr += chunk)),
    signal: new AbortController().signal,
  };
  return { dependencies, output: () => ({ stdout, stderr }) };
}

function fakeClient(overrides: Partial<FleetClient> = {}): FleetClient {
  const unavailable = async () =>
    err<FleetClientError>({ code: "internal_error", message: "unexpected" });
  return {
    create: unavailable,
    send: unavailable,
    receive: async function* () {
      yield err<FleetClientError>({ code: "internal_error", message: "unexpected" });
    },
    status: async () => ok({ schemaVersion: 1, type: "agent.status", agent }),
    list: unavailable,
    destroy: unavailable,
    compact: unavailable,
    ...overrides,
  };
}

const agent = {
  id: "agent-1",
  name: "reviewer",
  state: "idle" as const,
  process: { state: "resident" as const },
  session: { path: "/tmp/session.jsonl", id: "session-1" },
};

describe("public CLI contract", () => {
  it("preserves create arguments around the first literal separator", async () => {
    let received: unknown;
    let options: MutationOptions | undefined;
    const client = fakeClient({
      create: async (input, requestOptions) => {
        received = input;
        options = requestOptions;
        return ok({ schemaVersion: 1, type: "agent.created", agent });
      },
    });
    const harness = createHarness(client);

    const exitCode = await runCli(
      [
        "create",
        "reviewer",
        "Review auth",
        "--cwd",
        "project",
        "--",
        "--session",
        "./chosen.jsonl",
        "--thinking",
        "high",
      ],
      harness.dependencies,
    );

    expect(exitCode).toBe(0);
    expect(received).toEqual({
      name: "reviewer",
      instructions: "Review auth",
      cwd: "/workspace/project",
      piArgv: ["--session", "./chosen.jsonl", "--thinking", "high"],
    });
    expect(options?.operation.operationId).toBe("operation-1");
    expect(harness.output()).toEqual({
      stderr: "",
      stdout: `${JSON.stringify({ schemaVersion: 1, type: "agent.created", agent })}\n`,
    });
  });

  it("reads send input only when the message is an explicit dash", async () => {
    let message: string | undefined;
    const client = fakeClient({
      send: async (input) => {
        message = input.message;
        return ok({
          schemaVersion: 1,
          type: "message.accepted",
          agent: { id: agent.id, name: agent.name },
          acceptedAt: "2026-01-01T00:00:00.000Z",
        });
      },
    });
    const harness = createHarness(client, "multiline\nmessage\n");

    expect(await runCli(["send", "reviewer", "-"], harness.dependencies)).toBe(0);
    expect(message).toBe("multiline\nmessage\n");
    expect(harness.output().stderr).toBe("");
  });

  it("streams receive readiness on stderr and semantic events on stdout", async () => {
    const event = {
      id: "event-1",
      activityId: "activity-1",
      cursor: "cursor-1",
      agentId: agent.id,
      epoch: 0,
      sourceRawPosition: 1,
      observedAt: "2026-01-01T00:00:00.000Z",
      type: "assistant.message.started",
    } as const;
    const client = fakeClient({
      receive: async function* () {
        yield ok({ type: "ready", cursor: "cursor-0" as never });
        yield ok({ type: "event", cursor: "cursor-1" as never, event: event as never });
      },
    });
    const harness = createHarness(client);

    expect(await runCli(["receive", "reviewer", "--until-idle"], harness.dependencies)).toBe(0);
    expect(harness.output()).toEqual({
      stderr: `${JSON.stringify({ schemaVersion: 1, type: "receive.ready", cursor: "cursor-0" })}\n`,
      stdout: `${JSON.stringify(event)}\n`,
    });
  });

  it("returns structured invalid-argument errors without stdout", async () => {
    const harness = createHarness(fakeClient());

    expect(await runCli(["create", "INVALID"], harness.dependencies)).toBe(1);
    expect(harness.output().stdout).toBe("");
    expect(JSON.parse(harness.output().stderr)).toMatchObject({
      schemaVersion: 1,
      type: "error",
      error: { code: "invalid_arguments" },
    });
  });

  it("supports compact through JSON and human public formats", async () => {
    const client = fakeClient({
      compact: async () =>
        ok({
          schemaVersion: 1,
          type: "agent.compacted",
          agent: { id: agent.id, name: agent.name },
          compaction: { tokensBefore: 1200, estimatedTokensAfter: 300 },
        }),
    });
    const json = createHarness(client);
    expect(await runCli(["compact", "reviewer"], json.dependencies)).toBe(0);
    expect(JSON.parse(json.output().stdout)).toMatchObject({ type: "agent.compacted" });

    const human = createHarness(client);
    expect(await runCli(["compact", "reviewer", "--human"], human.dependencies)).toBe(0);
    expect(human.output().stdout).toBe("reviewer: compacted (1200 → 300 estimated tokens)\n");
  });

  it("supports status, list, and destroy through their public formats", async () => {
    const client = fakeClient({
      status: async () => ok({ schemaVersion: 1, type: "agent.status", agent }),
      list: async () => ok({ schemaVersion: 1, type: "agent.list", agents: [agent] }),
      destroy: async () =>
        ok({
          schemaVersion: 1,
          type: "agent.destroyed",
          agent: { id: agent.id, name: agent.name },
        }),
    });

    const status = createHarness(client);
    expect(await runCli(["status", "reviewer", "--human"], status.dependencies)).toBe(0);
    expect(status.output().stdout).toBe("reviewer: idle (resident)\n");

    const list = createHarness(client);
    expect(await runCli(["list"], list.dependencies)).toBe(0);
    expect(JSON.parse(list.output().stdout)).toMatchObject({ type: "agent.list" });

    const destroy = createHarness(client);
    expect(await runCli(["destroy", "reviewer", "--human"], destroy.dependencies)).toBe(0);
    expect(destroy.output().stdout).toBe("reviewer: destroyed\n");
  });

  it("rejects Pi arguments on commands other than create", async () => {
    const harness = createHarness(fakeClient());

    expect(
      await runCli(
        ["send", "reviewer", "message", "--", "--thinking", "high"],
        harness.dependencies,
      ),
    ).toBe(1);
    expect(JSON.parse(harness.output().stderr)).toMatchObject({
      error: { code: "invalid_arguments" },
    });
  });

  it("rejects historical boundaries with the live-only until-idle projection", async () => {
    for (const argv of [
      ["receive", "reviewer", "--after", "cursor", "--until-idle"],
      ["receive", "reviewer", "--from-start", "--until-idle"],
    ]) {
      const harness = createHarness(fakeClient());
      expect(await runCli(argv, harness.dependencies)).toBe(1);
      expect(harness.output().stdout).toBe("");
      expect(JSON.parse(harness.output().stderr)).toMatchObject({
        error: { code: "invalid_arguments" },
      });
    }
  });

  it("rejects the removed watch command", async () => {
    const harness = createHarness(fakeClient());

    expect(await runCli(["watch", "reviewer"], harness.dependencies)).toBe(1);
    expect(harness.output().stdout).toBe("");
    expect(JSON.parse(harness.output().stderr)).toMatchObject({
      error: { code: "invalid_arguments" },
    });
  });
});
