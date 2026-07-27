import type {
  ActivityId,
  AgentEventId,
  AgentId,
  ContinuityEpoch,
  ProjectorActivity,
  ProjectorState,
  ReceiveCursor,
  SemanticEvent,
} from "./semantic-events.js";

export interface LifecycleProjectionInput {
  readonly agentId: AgentId;
  readonly epoch: ContinuityEpoch;
  readonly rawPosition: number;
  readonly observedAt: string;
  readonly frame: unknown;
}

export interface LifecycleProjection {
  readonly events: readonly SemanticEvent[];
  readonly state: ProjectorState;
}

export function initialProjectorState(): ProjectorState {
  return { version: 1, messageSequence: 0, finishedThinkingIndexes: [], openActivities: [] };
}

/** Pure Pi 0.82.1 RPC-to-semantic projection. Unknown records produce no event. */
export function projectLifecycleRecord(
  state: ProjectorState,
  input: LifecycleProjectionInput,
  maxOpenActivities: number,
): LifecycleProjection {
  if (!Number.isSafeInteger(maxOpenActivities) || maxOpenActivities <= 0) {
    throw new Error("maxOpenActivities must be a positive safe integer");
  }
  const frame = asObject(input.frame);
  if (frame === null) return { events: [], state };

  if (frame.type === "message_update") {
    return projectMessageUpdate(state, input, frame, maxOpenActivities);
  }
  if (frame.type === "message_end") return projectMessageEnd(state, input, frame);
  if (frame.type === "tool_execution_start") {
    return projectToolStart(state, input, frame, maxOpenActivities);
  }
  if (frame.type === "tool_execution_end") return projectToolEnd(state, input, frame);
  return { events: [], state };
}

function projectMessageUpdate(
  state: ProjectorState,
  input: LifecycleProjectionInput,
  frame: Record<string, unknown>,
  maxOpen: number,
): LifecycleProjection {
  const update = asObject(frame.assistantMessageEvent ?? frame.event);
  if (update === null) return { events: [], state };
  const contentIndex = integer(update.contentIndex);
  if (contentIndex === null) return { events: [], state };

  if (update.type === "thinking_delta") {
    return projectThinkingDelta(state, input, contentIndex, text(update.delta), maxOpen);
  }
  if (update.type === "thinking_end") {
    return projectThinkingEnd(state, input, contentIndex, text(update.content), maxOpen);
  }
  if (update.type === "text_delta") {
    return projectTextStart(state, input, text(update.delta), maxOpen);
  }
  if (update.type === "text_end") {
    return projectTextStart(state, input, text(update.content), maxOpen);
  }
  return { events: [], state };
}

function projectThinkingDelta(
  state: ProjectorState,
  input: LifecycleProjectionInput,
  contentIndex: number,
  delta: string | null,
  maxOpen: number,
): LifecycleProjection {
  if (delta === null) return { events: [], state };
  if (state.finishedThinkingIndexes.includes(contentIndex)) return { events: [], state };
  const existing = findThinking(state, contentIndex);
  if (existing !== undefined) {
    return {
      events: [],
      state: replaceActivity(state, existing, { ...existing, text: existing.text + delta }),
    };
  }
  if (!meaningful(delta)) return { events: [], state };

  const activityId = activityIdFor(input, `thinking:${state.messageSequence}:${contentIndex}`);
  const activity: ProjectorActivity = {
    kind: "thinking",
    activityId,
    messageSequence: state.messageSequence,
    contentIndex,
    text: delta,
  };
  const next = addActivity(state, activity, maxOpen);
  return { events: [event(input, activityId, 0, "assistant.thinking.started")], state: next };
}

function projectThinkingEnd(
  state: ProjectorState,
  input: LifecycleProjectionInput,
  contentIndex: number,
  completeText: string | null,
  maxOpen: number,
): LifecycleProjection {
  if (state.finishedThinkingIndexes.includes(contentIndex)) return { events: [], state };
  const existing = findThinking(state, contentIndex);
  if (!meaningful(completeText)) {
    if (existing !== undefined) {
      throw new Error("Lifecycle projector finalized thinking contradicts its started activity");
    }
    return { events: [], state: markThinkingFinished(state, contentIndex, maxOpen) };
  }

  const activityId =
    existing?.activityId ??
    activityIdFor(input, `thinking:${state.messageSequence}:${contentIndex}`);
  const started =
    existing === undefined ? [event(input, activityId, 0, "assistant.thinking.started")] : [];
  const finished = event(input, activityId, started.length, "assistant.thinking.finished", {
    text: completeText,
  });
  return {
    events: [...started, finished],
    state: finishThinking(state, activityId, contentIndex, maxOpen),
  };
}

function projectTextStart(
  state: ProjectorState,
  input: LifecycleProjectionInput,
  content: string | null,
  maxOpen: number,
): LifecycleProjection {
  if (!meaningful(content) || findMessage(state) !== undefined) return { events: [], state };
  const activityId = activityIdFor(input, `message:${state.messageSequence}`);
  const activity: ProjectorActivity = {
    kind: "message",
    activityId,
    messageSequence: state.messageSequence,
  };
  return {
    events: [event(input, activityId, 0, "assistant.message.started")],
    state: addActivity(state, activity, maxOpen),
  };
}

function projectMessageEnd(
  state: ProjectorState,
  input: LifecycleProjectionInput,
  frame: Record<string, unknown>,
): LifecycleProjection {
  const completeText = assistantText(frame.message ?? asObject(frame.data)?.message);
  const existing = findMessage(state);
  const unfinishedThinking = state.openActivities.find(
    (activity) =>
      activity.kind === "thinking" && activity.messageSequence === state.messageSequence,
  );
  if (unfinishedThinking !== undefined) {
    throw new Error("Lifecycle projector completed message omits a finished thinking activity");
  }
  if (existing !== undefined && !meaningful(completeText)) {
    throw new Error("Lifecycle projector finalized message contradicts its started activity");
  }
  const events: SemanticEvent[] = [];
  let subposition = 0;
  let activityId = existing?.activityId;
  if (meaningful(completeText)) {
    if (activityId === undefined) {
      activityId = activityIdFor(input, `message:${state.messageSequence}`);
      events.push(event(input, activityId, subposition++, "assistant.message.started"));
    }
    events.push(
      event(input, activityId, subposition, "assistant.message.finished", { text: completeText }),
    );
  }

  return {
    events,
    state: {
      version: 1,
      messageSequence: state.messageSequence + 1,
      finishedThinkingIndexes: [],
      openActivities: state.openActivities.filter(
        (activity) =>
          activity.kind === "tool" || activity.messageSequence !== state.messageSequence,
      ),
    },
  };
}

function projectToolStart(
  state: ProjectorState,
  input: LifecycleProjectionInput,
  frame: Record<string, unknown>,
  maxOpen: number,
): LifecycleProjection {
  const callId = text(frame.toolCallId);
  const name = text(frame.toolName);
  if (callId === null || name === null || findTool(state, callId) !== undefined) {
    return { events: [], state };
  }
  const activityId = activityIdFor(input, `tool:${callId}`);
  const activity: ProjectorActivity = {
    kind: "tool",
    activityId,
    callId,
    name,
    input: frame.args,
  };
  return {
    events: [
      event(input, activityId, 0, "tool.execution.started", {
        tool: { callId, name, input: frame.args },
      }),
    ],
    state: addActivity(state, activity, maxOpen),
  };
}

function projectToolEnd(
  state: ProjectorState,
  input: LifecycleProjectionInput,
  frame: Record<string, unknown>,
): LifecycleProjection {
  const callId = text(frame.toolCallId);
  if (callId === null) return { events: [], state };
  const existing = findTool(state, callId);
  if (existing === undefined) return { events: [], state };
  return {
    events: [
      event(input, existing.activityId, 0, "tool.execution.finished", {
        tool: {
          callId,
          name: existing.name,
          input: existing.input,
          output: frame.result,
          isError: frame.isError === true,
        },
      }),
    ],
    state: removeActivity(state, existing.activityId),
  };
}

function event(
  input: LifecycleProjectionInput,
  activityId: ActivityId,
  subposition: number,
  type: SemanticEvent["type"],
  payload: Record<string, unknown> = {},
): SemanticEvent {
  const id = `${input.agentId}:${input.epoch}:${input.rawPosition}:${subposition}` as AgentEventId;
  return {
    id,
    activityId,
    agentId: input.agentId,
    cursor: id as unknown as ReceiveCursor,
    epoch: input.epoch,
    sourceRawPosition: input.rawPosition,
    observedAt: input.observedAt,
    type,
    ...payload,
  } as SemanticEvent;
}

function activityIdFor(input: LifecycleProjectionInput, suffix: string): ActivityId {
  return `${input.agentId}:${input.epoch}:${suffix}:${input.rawPosition}` as ActivityId;
}

function findThinking(state: ProjectorState, contentIndex: number) {
  return state.openActivities.find(
    (activity): activity is Extract<ProjectorActivity, { kind: "thinking" }> =>
      activity.kind === "thinking" &&
      activity.messageSequence === state.messageSequence &&
      activity.contentIndex === contentIndex,
  );
}

function findMessage(state: ProjectorState) {
  return state.openActivities.find(
    (activity): activity is Extract<ProjectorActivity, { kind: "message" }> =>
      activity.kind === "message" && activity.messageSequence === state.messageSequence,
  );
}

function findTool(state: ProjectorState, callId: string) {
  return state.openActivities.find(
    (activity): activity is Extract<ProjectorActivity, { kind: "tool" }> =>
      activity.kind === "tool" && activity.callId === callId,
  );
}

function addActivity(
  state: ProjectorState,
  activity: ProjectorActivity,
  maxOpen: number,
): ProjectorState {
  if (state.openActivities.length >= maxOpen) {
    throw new Error("Lifecycle projector open activity capacity exceeded");
  }
  return { ...state, openActivities: [...state.openActivities, activity] };
}

function replaceActivity(
  state: ProjectorState,
  current: ProjectorActivity,
  replacement: ProjectorActivity,
): ProjectorState {
  return {
    ...state,
    openActivities: state.openActivities.map((activity) =>
      activity.activityId === current.activityId ? replacement : activity,
    ),
  };
}

function removeActivity(state: ProjectorState, activityId: ActivityId): ProjectorState {
  return {
    ...state,
    openActivities: state.openActivities.filter((activity) => activity.activityId !== activityId),
  };
}

function finishThinking(
  state: ProjectorState,
  activityId: ActivityId,
  contentIndex: number,
  maxTracked: number,
): ProjectorState {
  return markThinkingFinished(removeActivity(state, activityId), contentIndex, maxTracked);
}

function markThinkingFinished(
  state: ProjectorState,
  contentIndex: number,
  maxTracked: number,
): ProjectorState {
  if (state.finishedThinkingIndexes.length >= maxTracked) {
    throw new Error("Lifecycle projector completed thinking capacity exceeded");
  }
  return {
    ...state,
    finishedThinkingIndexes: [...state.finishedThinkingIndexes, contentIndex],
  };
}

function meaningful(value: string | null): value is string {
  return value !== null && /\S/u.test(value);
}

function assistantText(value: unknown): string | null {
  const message = asObject(value);
  if (message === null || message.role !== "assistant" || !Array.isArray(message.content))
    return null;
  return message.content
    .map((part) => asObject(part))
    .filter((part): part is Record<string, unknown> => part?.type === "text")
    .map((part) => text(part.text) ?? "")
    .join("");
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function integer(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : null;
}
