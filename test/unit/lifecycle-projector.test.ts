import { describe, expect, it } from "vitest";

import {
  initialProjectorState,
  projectLifecycleRecord,
} from "../../src/runtime/lifecycle-projector.js";
import type {
  AgentId,
  ContinuityEpoch,
  ProjectorState,
} from "../../src/runtime/semantic-events.js";

const agentId = "agent-1" as AgentId;
const epoch = 1 as ContinuityEpoch;

function project(state: ProjectorState, rawPosition: number, frame: unknown) {
  return projectLifecycleRecord(
    state,
    { agentId, epoch, rawPosition, observedAt: "2026-01-01T00:00:00.000Z", frame },
    8,
  );
}

function update(type: string, contentIndex: number, fields: Record<string, unknown> = {}) {
  return { type: "message_update", assistantMessageEvent: { type, contentIndex, ...fields } };
}

describe("lifecycle projector", () => {
  it("emits distinct thinking pairs only for meaningful blocks", () => {
    let state = initialProjectorState();
    expect(project(state, 1, update("thinking_delta", 0, { delta: "   " })).events).toEqual([]);

    let result = project(state, 2, update("thinking_delta", 0, { delta: " first" }));
    expect(result.events.map((event) => event.type)).toEqual(["assistant.thinking.started"]);
    state = result.state;

    result = project(state, 3, update("thinking_end", 0, { content: "  first  " }));
    expect(result.events).toMatchObject([
      { type: "assistant.thinking.finished", text: "  first  " },
    ]);
    const firstActivity = result.events[0]?.activityId;
    state = result.state;

    result = project(state, 4, update("thinking_end", 1, { content: "second" }));
    expect(result.events.map((event) => event.type)).toEqual([
      "assistant.thinking.started",
      "assistant.thinking.finished",
    ]);
    expect(result.events[0]?.activityId).toBe(result.events[1]?.activityId);
    expect(result.events[0]?.activityId).not.toBe(firstActivity);
    expect(
      project(result.state, 5, update("thinking_end", 1, { content: "second" })).events,
    ).toEqual([]);
  });

  it("rejects an empty thinking finish after a meaningful start", () => {
    const started = project(
      initialProjectorState(),
      1,
      update("thinking_delta", 0, { delta: "meaningful" }),
    );

    expect(() => project(started.state, 2, update("thinking_end", 0, { content: "   " }))).toThrow(
      "finalized thinking contradicts its started activity",
    );
    expect(started.state.openActivities).toHaveLength(1);
  });

  it("keeps an empty thinking block terminal without public events", () => {
    const finished = project(
      initialProjectorState(),
      1,
      update("thinking_end", 0, { content: "   " }),
    );
    expect(finished.events).toEqual([]);
    expect(finished.state.finishedThinkingIndexes).toEqual([0]);

    const late = project(finished.state, 2, update("thinking_delta", 0, { delta: "too late" }));
    expect(late.events).toEqual([]);
    expect(late.state).toEqual(finished.state);
  });

  it("emits one visible message pair with finalized text blocks and no separators", () => {
    let result = project(initialProjectorState(), 1, update("text_delta", 0, { delta: "hello" }));
    expect(result.events.map((event) => event.type)).toEqual(["assistant.message.started"]);

    result = project(result.state, 2, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "hello " },
          { type: "thinking", thinking: "not visible" },
          { type: "text", text: "world" },
        ],
      },
    });
    expect(result.events).toMatchObject([
      { type: "assistant.message.finished", text: "hello world" },
    ]);
    expect(result.state.messageSequence).toBe(1);
    expect(result.state.openActivities).toEqual([]);
  });

  it("rejects an empty finalized message after a meaningful start", () => {
    const started = project(
      initialProjectorState(),
      1,
      update("text_delta", 0, { delta: "meaningful" }),
    );

    expect(() =>
      project(started.state, 2, {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "   " }] },
      }),
    ).toThrow("finalized message contradicts its started activity");
    expect(started.state.openActivities).toHaveLength(1);
  });

  it("rejects message completion that omits a started thinking finish", () => {
    const started = project(
      initialProjectorState(),
      1,
      update("thinking_delta", 0, { delta: "unfinished" }),
    );

    expect(() =>
      project(started.state, 2, {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "  " }] },
      }),
    ).toThrow("completed message omits a finished thinking activity");
    expect(started.state.openActivities).toHaveLength(1);
  });

  it("emits self-contained tool finishes and ignores unmatched ends", () => {
    let result = project(initialProjectorState(), 1, {
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "printf ok" },
    });
    expect(result.events).toMatchObject([
      {
        type: "tool.execution.started",
        tool: { callId: "call-1", name: "bash", input: { command: "printf ok" } },
      },
    ]);

    result = project(result.state, 2, {
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "bash",
      result: { content: "ok" },
      isError: false,
    });
    expect(result.events).toMatchObject([
      {
        type: "tool.execution.finished",
        tool: {
          callId: "call-1",
          name: "bash",
          input: { command: "printf ok" },
          output: { content: "ok" },
          isError: false,
        },
      },
    ]);
    expect(
      project(result.state, 3, { type: "tool_execution_end", toolCallId: "missing" }).events,
    ).toEqual([]);
  });

  it("bounds completed thinking metadata within an assistant envelope", () => {
    const first = projectLifecycleRecord(
      initialProjectorState(),
      {
        agentId,
        epoch,
        rawPosition: 1,
        observedAt: "2026-01-01T00:00:00.000Z",
        frame: update("thinking_end", 0, { content: "first" }),
      },
      1,
    );
    expect(() =>
      projectLifecycleRecord(
        first.state,
        {
          agentId,
          epoch,
          rawPosition: 2,
          observedAt: "2026-01-01T00:00:01.000Z",
          frame: update("thinking_end", 1, { content: "second" }),
        },
        1,
      ),
    ).toThrow("completed thinking capacity exceeded");
  });

  it("keeps IDs deterministic and excludes unsupported records", () => {
    const input = update("text_end", 0, { content: "visible" });
    const first = project(initialProjectorState(), 9, input);
    const second = project(initialProjectorState(), 9, input);
    expect(second).toEqual(first);
    expect(project(initialProjectorState(), 10, { type: "auto_retry_start" }).events).toEqual([]);
    expect(project(initialProjectorState(), 11, { type: "compaction_start" }).events).toEqual([]);
  });
});
