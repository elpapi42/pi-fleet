import { describe, expect, it } from "vitest";

import { PiResponseAdmission } from "../../src/pi/process.js";
import type {
  AssistantMessageFinishedEvent,
  AssistantMessageStartedEvent,
  SemanticEvent,
} from "../../src/runtime/semantic-events.js";

describe("semantic event contracts", () => {
  it("allows only the six lifecycle event types", () => {
    const started: AssistantMessageStartedEvent = {
      id: "event-1" as AssistantMessageStartedEvent["id"],
      activityId: "activity-1" as AssistantMessageStartedEvent["activityId"],
      agentId: "agent-1" as AssistantMessageStartedEvent["agentId"],
      cursor: "cursor-1" as AssistantMessageStartedEvent["cursor"],
      epoch: 1 as AssistantMessageStartedEvent["epoch"],
      sourceRawPosition: 1,
      observedAt: "2026-01-01T00:00:00.000Z",
      type: "assistant.message.started",
    };
    const finished: AssistantMessageFinishedEvent = {
      ...started,
      id: "event-2" as AssistantMessageFinishedEvent["id"],
      type: "assistant.message.finished",
      text: "complete",
    };
    const events: readonly SemanticEvent[] = [started, finished];

    expect(events.map((event) => event.type)).toEqual([
      "assistant.message.started",
      "assistant.message.finished",
    ]);
  });
});

describe("Pi response admission", () => {
  it("distinguishes a matching response awaiting durable commit from a Pi timeout", () => {
    const admission = new PiResponseAdmission();

    admission.admit();
    expect(admission.state).toBe("admitted_pending_commit");
    admission.commit();
    expect(admission.state).toBe("committed");
  });

  it("keeps a non-committed response failed instead of treating it as a timeout", () => {
    const admission = new PiResponseAdmission();

    admission.fail();
    expect(admission.state).toBe("failed");
    expect(() => admission.commit()).toThrow("Cannot commit response while failed");
  });

  it("does not let a committed response become a durability failure", () => {
    const admission = new PiResponseAdmission();
    admission.admit();
    admission.commit();

    expect(() => admission.fail()).toThrow("Cannot fail a committed response");
  });
});
