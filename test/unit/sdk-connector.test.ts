import { describe, expect, it } from "vitest";

import type {
  FleetClient,
  FleetClientError,
  ReceiveInput,
  ReceiveStreamItem,
} from "../../src/client/fleet-client.js";
import type { ReceiveCursor, SemanticEvent } from "../../src/client/contracts.js";
import { createSdkConnector } from "../../src/client/sdk-connector.js";
import type { SharedClientConnection } from "../../src/client/shared-client.js";
import { err, ok, type Result } from "../../src/shared/result.js";

function reachableClient(
  list: () => Promise<
    Result<{ readonly agents: readonly unknown[] }, FleetClientError>
  > = async () => ok({ agents: [] }),
): FleetClient {
  return { list } as unknown as FleetClient;
}

const lowLevelClient = reachableClient();

async function* receiveItems(
  values: readonly Result<ReceiveStreamItem, FleetClientError>[],
): AsyncIterable<Result<ReceiveStreamItem, FleetClientError>> {
  yield* values;
}

function messageStarted(cursor: string): SemanticEvent {
  return {
    id: "event-1" as never,
    activityId: "activity-1" as never,
    cursor: cursor as ReceiveCursor,
    type: "assistant.message.started",
    agentId: "agent-1" as never,
    epoch: 0 as never,
    sourceRawPosition: 1,
    observedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("SDK connector", () => {
  it("starts only the shared control plane by default and keeps Pi selection lazy", async () => {
    let starts = 0;
    let piSelections = 0;
    let receivedOptions: unknown;
    const connector = createSdkConnector({
      createConnection(options): SharedClientConnection {
        receivedOptions = options;
        return {
          client: lowLevelClient,
          operationIds: () => ({
            operationId: "operation-1",
            createdAt: "2026-01-01T00:00:00.000Z",
          }),
          async ensureControlPlane() {
            starts += 1;
          },
          async selectPiForMutation() {
            piSelections += 1;
            throw new Error("not used");
          },
        };
      },
    });

    const transport = await connector.connect({
      stateRoot: "/state",
      applicationRoot: "/application",
    });

    expect(starts).toBe(1);
    expect(piSelections).toBe(0);
    expect(receivedOptions).toEqual({
      stateRoot: "/state",
      applicationRoot: "/application",
      autoStartRuntime: true,
    });
    await transport.close();
  });

  it("supports connect-only mode without starting a runtime", async () => {
    let starts = 0;
    const connector = createSdkConnector({
      createConnection(): SharedClientConnection {
        return {
          client: lowLevelClient,
          operationIds: () => ({
            operationId: "operation-1",
            createdAt: "2026-01-01T00:00:00.000Z",
          }),
          async ensureControlPlane() {
            starts += 1;
          },
          async selectPiForMutation() {
            throw new Error("not used");
          },
        };
      },
    });

    await connector.connect({ autoStartRuntime: false });
    expect(starts).toBe(0);
  });

  it("keeps continuity-safe receive reconnect enabled in connect-only mode", async () => {
    let starts = 0;
    let attempt = 0;
    const receiveStarts: ReceiveInput[] = [];
    const receiveClient = {
      async list() {
        return ok({ agents: [] });
      },
      receive(input: ReceiveInput) {
        receiveStarts.push(input);
        attempt += 1;
        return attempt === 1
          ? receiveItems([
              ok({ type: "ready", cursor: "cursor-0" as ReceiveCursor }),
              err({ code: "runtime_unavailable", message: "runtime restarted" }),
            ])
          : receiveItems([
              ok({ type: "ready", cursor: "cursor-0" as ReceiveCursor }),
              ok({
                type: "event",
                cursor: "cursor-1" as ReceiveCursor,
                event: messageStarted("cursor-1"),
              }),
            ]);
      },
    } as unknown as FleetClient;
    const connector = createSdkConnector({
      createConnection(): SharedClientConnection {
        return {
          client: receiveClient,
          operationIds: () => ({
            operationId: "operation-1",
            createdAt: "2026-01-01T00:00:00.000Z",
          }),
          async ensureControlPlane() {
            starts += 1;
          },
          async selectPiForMutation() {
            throw new Error("not used");
          },
        };
      },
    });

    const transport = await connector.connect({ autoStartRuntime: false });
    const stream = await transport.receive(
      { name: "reviewer", expectedAgentId: "agent-1" as never },
      { kind: "live" },
      new AbortController().signal,
    );
    const iterator = stream[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { id: "event-1", cursor: "cursor-1" },
    });
    await iterator.return?.();

    expect(starts).toBe(0);
    expect(receiveStarts.map((input) => input.start)).toEqual([
      { kind: "live" },
      { kind: "after", cursor: "cursor-0" },
    ]);
  });

  it("cancels the local connection wait without claiming to cancel runtime startup", async () => {
    const controller = new AbortController();
    let finishStartup: (() => void) | undefined;
    const connector = createSdkConnector({
      createConnection(): SharedClientConnection {
        return {
          client: lowLevelClient,
          operationIds: () => ({
            operationId: "operation-1",
            createdAt: "2026-01-01T00:00:00.000Z",
          }),
          ensureControlPlane: () =>
            new Promise<void>((resolve) => {
              finishStartup = resolve;
            }),
          async selectPiForMutation() {
            throw new Error("not used");
          },
        };
      },
    });

    const connection = connector.connect({ signal: controller.signal });
    controller.abort();
    const outcome = await Promise.race([
      connection.then(
        () => "resolved",
        (error: unknown) => (error as { code?: string }).code,
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve("still-waiting"), 10)),
    ]);
    expect(outcome).toBe("cancelled");
    finishStartup?.();
  });

  it.each([
    { code: "runtime_unavailable" as const, label: "an absent runtime" },
    { code: "protocol_incompatible" as const, label: "a responsive incompatible runtime" },
  ])("fails connecting against $label", async ({ code }) => {
    let starts = 0;
    const connector = createSdkConnector({
      createConnection(): SharedClientConnection {
        return {
          client: reachableClient(async () => err({ code, message: "unusable runtime" })),
          operationIds: () => ({
            operationId: "operation-1",
            createdAt: "2026-01-01T00:00:00.000Z",
          }),
          async ensureControlPlane() {
            starts += 1;
          },
          async selectPiForMutation() {
            throw new Error("not used");
          },
        };
      },
    });

    await expect(connector.connect({ autoStartRuntime: false })).rejects.toMatchObject({ code });
    expect(starts).toBe(0);
  });

  it("rejects an already-cancelled connection without startup work", async () => {
    let connections = 0;
    const controller = new AbortController();
    controller.abort();
    const connector = createSdkConnector({
      createConnection(): SharedClientConnection {
        connections += 1;
        throw new Error("must not run");
      },
    });

    await expect(connector.connect({ signal: controller.signal })).rejects.toMatchObject({
      code: "cancelled",
    });
    expect(connections).toBe(0);
  });
});
