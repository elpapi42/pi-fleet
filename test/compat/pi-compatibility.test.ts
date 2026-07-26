import { describe, expect, it } from "vitest";

import { runCompatibilityProbe } from "../../scripts/pi-compatibility-probe.mjs";
import { resolveExternalPiInstallation } from "../../src/pi/external-installation.js";

describe("installed Pi compatibility", () => {
  it("proves the native session, RPC, steering, settlement, and shutdown contract", async () => {
    const selectedPi = await resolveExternalPiInstallation({ env: process.env });
    const profile = await runCompatibilityProbe(selectedPi.selectedPath);

    expect(profile.artifact).toMatchObject({
      selectedPath: selectedPi.selectedPath,
      realPath: selectedPi.realPath,
      version: selectedPi.version,
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
