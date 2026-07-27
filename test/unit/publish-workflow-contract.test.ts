import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("published registry SDK smoke contract", () => {
  it("proves inert import, semantic delivery, and identity-safe cleanup ordering", async () => {
    const workflow = await readFile(".github/workflows/publish.yml", "utf8");

    const inertImport = workflow.indexOf('node "$root/sdk/inert.mjs"');
    const inertState = workflow.indexOf('test ! -e "$root/state"');
    const inertRuntime = workflow.indexOf(
      'test -z "$(pgrep -f -- "$root/application/releases" || true)"',
    );
    const versionCommand = workflow.indexOf('"$cli" --version');
    const firstRuntimeCommand = workflow.indexOf('"$cli" list');
    const providerReady = workflow.indexOf('provider_port="$(cat "$root/provider.port")"');
    const createAgent = workflow.indexOf('"$cli" create registry-smoke');
    const receive = workflow.indexOf("const stream = await agent.receive");
    const iteratorStart = workflow.indexOf("const finished = (async () => {");
    const send = workflow.indexOf('await agent.send("Return the deterministic response."');
    const finished = workflow.indexOf("await finished;");

    expect(inertImport).toBeGreaterThan(-1);
    expect(inertState).toBeGreaterThan(inertImport);
    expect(inertRuntime).toBeGreaterThan(inertState);
    expect(versionCommand).toBeGreaterThan(inertRuntime);
    expect(firstRuntimeCommand).toBeGreaterThan(versionCommand);
    expect(providerReady).toBeGreaterThan(-1);
    expect(createAgent).toBeGreaterThan(providerReady);
    expect(receive).toBeGreaterThan(createAgent);
    expect(iteratorStart).toBeGreaterThan(receive);
    expect(send).toBeGreaterThan(iteratorStart);
    expect(finished).toBeGreaterThan(send);

    expect(workflow).toContain('grep -Fxq "PIFLEET_STATE_ROOT=$root/state"');
    expect(workflow).toContain('stat="$(cat "/proc/$pid/stat" 2>/dev/null)"');
    expect(workflow).toContain('cleanup_starttimes["$pid"]="$starttime"');
    expect(workflow).toContain('[ "$current" = "${cleanup_starttimes[$pid]:-}" ]');
    expect(workflow).toContain('[ "$child_parent" = "$parent" ]');
    expect(workflow).toContain('[ "$after" = "$before" ]');
    expect(workflow).toContain('collect_descendants "$pid"');
    const providerPid = workflow.indexOf("provider_pid=$!");
    const trackProvider = workflow.indexOf('track_cleanup_pid "$provider_pid"', providerPid);
    expect(providerPid).toBeGreaterThan(-1);
    expect(trackProvider).toBeGreaterThan(providerPid);

    const cleanupStart = workflow.indexOf("\n          cleanup() {\n");
    const originalStatus = workflow.indexOf(
      "local original_status=$? cleanup_status=0 remaining",
      cleanupStart,
    );
    const clearTrap = workflow.indexOf("trap - EXIT", originalStatus);
    const collectIdentities = workflow.indexOf(
      "\n            collect_cleanup_identities\n",
      clearTrap,
    );
    const term = workflow.indexOf("signal_cleanup_identities TERM", collectIdentities);
    const postTermWait = workflow.indexOf("wait_for_cleanup 20 || true", term);
    const rescanAfterTerm = workflow.indexOf("collect_cleanup_identities", postTermWait);
    const firstKill = workflow.indexOf("signal_cleanup_identities KILL", rescanAfterTerm);
    const firstKillWait = workflow.indexOf("wait_for_cleanup 20 || true", firstKill);
    const rescanAfterFirstKill = workflow.indexOf("collect_cleanup_identities", firstKillWait);
    const secondKill = workflow.indexOf(
      "signal_cleanup_identities KILL",
      firstKill + "signal_cleanup_identities KILL".length,
    );
    const secondKillWait = workflow.indexOf("wait_for_cleanup 20 || true", secondKill);
    const finalRescan = workflow.indexOf("collect_cleanup_identities", secondKillWait);
    const verifiedAbsence = workflow.indexOf(
      'remaining="$(remaining_cleanup_identities)"',
      finalRescan,
    );
    const removeRoot = workflow.indexOf('rm -rf "$root"', verifiedAbsence);
    const preserveFailure = workflow.indexOf('exit "$original_status"', removeRoot);
    const propagateCleanup = workflow.indexOf('exit "$cleanup_status"', preserveFailure);

    expect(cleanupStart).toBeGreaterThan(-1);
    expect(originalStatus).toBeGreaterThan(cleanupStart);
    expect(clearTrap).toBeGreaterThan(originalStatus);
    expect(collectIdentities).toBeGreaterThan(clearTrap);
    expect(term).toBeGreaterThan(collectIdentities);
    expect(postTermWait).toBeGreaterThan(term);
    expect(rescanAfterTerm).toBeGreaterThan(postTermWait);
    expect(firstKill).toBeGreaterThan(rescanAfterTerm);
    expect(firstKillWait).toBeGreaterThan(firstKill);
    expect(rescanAfterFirstKill).toBeGreaterThan(firstKillWait);
    expect(secondKill).toBeGreaterThan(rescanAfterFirstKill);
    expect(secondKillWait).toBeGreaterThan(secondKill);
    expect(finalRescan).toBeGreaterThan(secondKillWait);
    expect(verifiedAbsence).toBeGreaterThan(finalRescan);
    expect(removeRoot).toBeGreaterThan(verifiedAbsence);
    expect(preserveFailure).toBeGreaterThan(removeRoot);
    expect(propagateCleanup).toBeGreaterThan(preserveFailure);

    expect(workflow).toContain('api":"openai-completions"');
    expect(workflow).toContain("--provider pifleet-smoke --model deterministic");
    expect(workflow).toContain('event.type === "assistant.message.finished"');
    expect(workflow).toContain('event.text === "deterministic response 1"');
  });
});
