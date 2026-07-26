import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { runCompatibilityProbe } from "../../scripts/pi-compatibility-probe.mjs";

const EXPECTED_SELECTED_PATH =
  process.env.PIFLEET_PI_EXECUTABLE ?? resolve(process.cwd(), "node_modules", ".bin", "pi");
const EXPECTED_VERSION = process.env.PIFLEET_PI_EXECUTABLE === undefined ? "0.80.10" : "0.82.1";

describe("installed Pi compatibility", () => {
  it("proves the native session, RPC, steering, settlement, and shutdown contract", async () => {
    const profile = await runCompatibilityProbe();

    expect(profile.artifact).toMatchObject({
      selectedPath: EXPECTED_SELECTED_PATH,
      realPath: expect.any(String),
      version: EXPECTED_VERSION,
    });
    expect(profile.selectors).toMatchObject({
      noSelectorReportsConcretePath: true,
      noSelectorStartsUnmaterialized: true,
      existingSessionUsesExactPathAndId: true,
      missingSessionUsesExactPath: true,
      missingSessionStartsUnmaterialized: true,
      sessionIdIsExact: true,
      sessionDirIsHonored: true,
      forkCreatesNewSession: true,
      forkMaterializesImmediately: true,
      continueReopensLatestConcreteSession: true,
      resumeWorksHeadlessly: false,
    });
    expect(profile.communication).toMatchObject({
      promptAcknowledged: true,
      activePromptAcceptedAsSteering: true,
      agentSettledObserved: true,
      latestAssistantTextObserved: true,
      sessionMaterializedAfterAssistant: true,
      modelRequestCount: 2,
    });
    expect(profile.process).toEqual({ rpcReady: true, cleanShutdown: true });
  }, 30_000);
});
