import { describe, expect, it } from "vitest";

import type {
  FleetClient,
  FleetClientError,
  MutationOptions,
  ReceiveInput,
  ReceiveStreamItem,
  RequestOptions,
} from "../../src/client/fleet-client.js";
import { FleetClientSdkTransport } from "../../src/client/sdk-transport.js";
import type { ReceiveCursor, SemanticEvent } from "../../src/runtime/semantic-events.js";
import { err, ok, type Result } from "../../src/shared/result.js";

const summary = {
  id: "agent-1",
  name: "reviewer",
  state: "idle" as const,
  process: { state: "absent" as const },
  session: { id: null, path: null },
};

function unsupported(): never {
  throw new Error("unexpected client method");
}

function client(overrides: Partial<FleetClient>): FleetClient {
  return {
    create: async () => unsupported(),
    send: async () => unsupported(),
    receive: () => unsupported(),
    status: async () => unsupported(),
    list: async () => unsupported(),
    destroy: async () => unsupported(),
    compact: async () => unsupported(),
    ...overrides,
  };
}

function event(cursor: string, eventId: string): SemanticEvent {
  return {
    id: eventId as never,
    activityId: `activity-${eventId}` as never,
    cursor: cursor as ReceiveCursor,
    type: "assistant.message.started",
    agentId: "agent-1" as never,
    epoch: 0 as never,
    sourceRawPosition: 1,
    observedAt: "2026-01-01T00:00:00.000Z",
  };
}

async function* items(
  values: readonly Result<ReceiveStreamItem, FleetClientError>[],
): AsyncIterable<Result<ReceiveStreamItem, FleetClientError>> {
  yield* values;
}

describe("FleetClientSdkTransport", () => {
  it("translates public create/send calls and generates mutation identities", async () => {
    const operations: string[] = [];
    const inputs: unknown[] = [];
    const transport = new FleetClientSdkTransport(
      client({
        async create(input, options: MutationOptions) {
          inputs.push(input);
          operations.push(options.operation.operationId);
          return ok({ schemaVersion: 1, type: "agent.created", agent: summary });
        },
        async send(input, options: MutationOptions) {
          inputs.push(input);
          operations.push(options.operation.operationId);
          return ok({
            schemaVersion: 1,
            type: "message.accepted",
            agent: { id: summary.id, name: summary.name },
            acceptedAt: "2026-01-01T00:00:01.000Z",
          });
        },
      }),
      (() => {
        let id = 0;
        return () => ({
          operationId: `operation-${++id}`,
          createdAt: "2026-01-01T00:00:00.000Z",
        });
      })(),
    );
    const signal = new AbortController().signal;

    await transport.create(
      { name: "reviewer", cwd: "/repo", piArgs: ["--session", "/tmp/reviewer.jsonl"] },
      signal,
    );
    await transport.send(
      { name: "reviewer", expectedAgentId: "agent-1" as never },
      "inspect",
      "followUp",
      signal,
    );

    expect(inputs).toEqual([
      {
        name: "reviewer",
        cwd: "/repo",
        piArgv: ["--session", "/tmp/reviewer.jsonl"],
      },
      {
        name: "reviewer",
        expectedAgentId: "agent-1",
        message: "inspect",
        delivery: "followUp",
      },
    ]);
    expect(operations).toEqual(["operation-1", "operation-2"]);
  });

  it("reconnects receive after runtime loss from the last emitted cursor", async () => {
    const starts: ReceiveInput[] = [];
    let attempt = 0;
    const transport = new FleetClientSdkTransport(
      client({
        receive(input: ReceiveInput, options: RequestOptions) {
          void options;
          starts.push(input);
          attempt += 1;
          if (attempt === 1) {
            return items([
              ok({ type: "ready", cursor: "cursor-0" as ReceiveCursor }),
              ok({
                type: "event",
                cursor: "cursor-1" as ReceiveCursor,
                event: event("cursor-1", "event-1"),
              }),
              err({ code: "runtime_unavailable", message: "runtime restarted" }),
            ]);
          }
          return items([
            ok({ type: "ready", cursor: "cursor-1" as ReceiveCursor }),
            ok({
              type: "event",
              cursor: "cursor-2" as ReceiveCursor,
              event: event("cursor-2", "event-2"),
            }),
          ]);
        },
      }),
      () => ({ operationId: "unused", createdAt: "2026-01-01T00:00:00.000Z" }),
      { reconnectDelayMs: 0 },
    );

    const stream = await transport.receive(
      { name: "reviewer", expectedAgentId: "agent-1" as never },
      { kind: "live" },
      new AbortController().signal,
    );
    const received: string[] = [];
    for await (const value of stream) {
      received.push(value.id);
      if (received.length === 2) break;
    }

    expect(stream.cursor).toBe("cursor-0");
    expect(received).toEqual(["event-1", "event-2"]);
    expect(starts).toEqual([
      {
        name: "reviewer",
        expectedAgentId: "agent-1",
        start: { kind: "live" },
      },
      {
        name: "reviewer",
        expectedAgentId: "agent-1",
        start: { kind: "after", cursor: "cursor-1" },
      },
    ]);
  });

  it("closes an attached receive iterator even when callers never begin iteration", async () => {
    let returns = 0;
    const receiveClient = client({
      receive() {
        let emitted = false;
        return {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                if (!emitted) {
                  emitted = true;
                  return {
                    done: false as const,
                    value: ok({
                      type: "ready" as const,
                      cursor: "cursor-0" as ReceiveCursor,
                    }),
                  };
                }
                return new Promise<never>(() => undefined);
              },
              async return() {
                returns += 1;
                return { done: true as const, value: undefined };
              },
            };
          },
        };
      },
    });
    const transport = new FleetClientSdkTransport(receiveClient, () => ({
      operationId: "unused",
      createdAt: "2026-01-01T00:00:00.000Z",
    }));

    await transport.receive(
      { name: "reviewer", expectedAgentId: "agent-1" as never },
      { kind: "live" },
      new AbortController().signal,
    );
    await transport.close();
    expect(returns).toBe(1);
  });

  it("does not reconnect across an observation uncertainty error", async () => {
    let attempts = 0;
    const transport = new FleetClientSdkTransport(
      client({
        receive() {
          attempts += 1;
          return items([
            ok({ type: "ready", cursor: "cursor-safe" as ReceiveCursor }),
            err({
              code: "observation_uncertain",
              message: "observation gap",
              details: {
                lastSafeCursor: "cursor-safe",
                continuationCursor: "cursor-next",
              },
            }),
          ]);
        },
      }),
      () => ({ operationId: "unused", createdAt: "2026-01-01T00:00:00.000Z" }),
      { reconnectDelayMs: 0 },
    );
    const stream = await transport.receive(
      { name: "reviewer", expectedAgentId: "agent-1" as never },
      { kind: "live" },
      new AbortController().signal,
    );

    await expect(async () => {
      for await (const unexpectedEvent of stream) {
        throw new Error(`Unexpected event ${unexpectedEvent.id}`);
      }
    }).rejects.toMatchObject({
      code: "observation_uncertain",
      details: { lastSafeCursor: "cursor-safe", continuationCursor: "cursor-next" },
    });
    expect(attempts).toBe(1);
  });
});
