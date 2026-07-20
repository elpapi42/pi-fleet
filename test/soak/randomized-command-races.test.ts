import { describe, expect, it } from "vitest";

import type { PiLauncher } from "../../src/pi/adapter.js";
import type { AgentLaunchProfile } from "../../src/pi/launch-profile.js";
import type { PiProcess } from "../../src/pi/process.js";
import { FleetService } from "../../src/runtime/fleet-service.js";
import { MemoryFleetStore } from "../../src/store/memory-store.js";

const SEEDS = [1, 7, 42, 1_337, 0xdeadbeef] as const;
const AGENT_NAMES = ["race-a", "race-b", "race-c"] as const;
const ACTIONS_PER_SEED = 48;

type AgentName = (typeof AGENT_NAMES)[number];
type ActionKind = "create" | "send" | "status" | "receive" | "destroy" | "process-exit";

interface RaceAction {
  readonly index: number;
  readonly kind: ActionKind;
  readonly name: AgentName;
  readonly barrierTurns: number;
}

interface ControlledPiProcess extends PiProcess {
  simulateExit(): void;
}

function createPrng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

function generateActions(seed: number): readonly RaceAction[] {
  const next = createPrng(seed);
  const kinds: readonly ActionKind[] = [
    "create",
    "send",
    "send",
    "status",
    "receive",
    "destroy",
    "process-exit",
  ];
  return Array.from({ length: ACTIONS_PER_SEED }, (_, index) => ({
    index,
    kind: kinds[next() % kinds.length]!,
    name: AGENT_NAMES[next() % AGENT_NAMES.length]!,
    barrierTurns: next() % 4,
  }));
}

async function passMicrotaskBarrier(turns: number): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
}

function controlledLauncher() {
  const current = new Map<AgentName, ControlledPiProcess>();
  const live = new Map<AgentName, number>();
  const maximumLive = new Map<AgentName, number>();
  let starts = 0;
  let ends = 0;

  function processName(profile: AgentLaunchProfile): AgentName {
    const name = profile.cwd.slice(profile.cwd.lastIndexOf("/") + 1);
    if (!AGENT_NAMES.includes(name as AgentName)) throw new Error(`Unexpected test agent ${name}`);
    return name as AgentName;
  }

  const launcher: PiLauncher = {
    artifactId: "race-pi",
    async start(profile) {
      const name = processName(profile);
      starts += 1;
      const nextLive = (live.get(name) ?? 0) + 1;
      live.set(name, nextLive);
      maximumLive.set(name, Math.max(maximumLive.get(name) ?? 0, nextLive));

      let ended = false;
      let exitListener: ((error: Error | null) => void) | undefined;
      const end = () => {
        if (ended) return;
        ended = true;
        ends += 1;
        live.set(name, Math.max(0, (live.get(name) ?? 1) - 1));
        if (current.get(name) === process) current.delete(name);
        exitListener?.(null);
      };
      const process = {
        pid: 80_000 + starts,
        async getState() {
          return {
            isStreaming: false,
            isCompacting: false,
            pendingMessageCount: 0,
            sessionFile: `/tmp/${name}.jsonl`,
            sessionId: `${name}-session`,
          };
        },
        async prompt() {
          await Promise.resolve();
        },
        async getLastAssistantText() {
          return null;
        },
        onFrame() {
          return () => undefined;
        },
        onExit(listener: (error: Error | null) => void) {
          exitListener = listener;
          return () => {
            if (exitListener === listener) exitListener = undefined;
          };
        },
        async stop() {
          end();
        },
        simulateExit() {
          end();
        },
      } as unknown as ControlledPiProcess;
      current.set(name, process);
      return process;
    },
  };

  return {
    launcher,
    simulateExit(name: AgentName) {
      current.get(name)?.simulateExit();
    },
    starts: () => starts,
    ends: () => ends,
    totalLive: () => [...live.values()].reduce((total, count) => total + count, 0),
    maximumFor: (name: AgentName) => maximumLive.get(name) ?? 0,
  };
}

async function executeAction(
  service: FleetService,
  pi: ReturnType<typeof controlledLauncher>,
  seed: number,
  action: RaceAction,
): Promise<void> {
  await passMicrotaskBarrier(action.barrierTurns);
  const operationId = `seed-${String(seed)}-${action.kind}-${String(action.index)}`;
  switch (action.kind) {
    case "create":
      await service.create(
        { name: action.name, cwd: `/tmp/${action.name}`, piArgv: [] },
        operationId,
      );
      return;
    case "send":
      await service.send(
        { name: action.name, message: `seed ${String(seed)} action ${String(action.index)}` },
        operationId,
      );
      return;
    case "status":
      await service.status({ name: action.name });
      return;
    case "receive":
      await service.receive({ name: action.name });
      return;
    case "destroy":
      await service.destroy({ name: action.name }, operationId);
      return;
    case "process-exit":
      pi.simulateExit(action.name);
  }
}

async function runSeed(seed: number): Promise<void> {
  const actions = generateActions(seed);
  const store = new MemoryFleetStore();
  const pi = controlledLauncher();
  const service = new FleetService(store, { launcher: pi.launcher });

  try {
    const outcomes = await Promise.allSettled(
      actions.map((action) => executeAction(service, pi, seed, action)),
    );
    const rejected = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
    );
    expect(rejected, `seed=${String(seed)} actions=${JSON.stringify(actions)}`).toEqual([]);

    for (const name of AGENT_NAMES) {
      await service.destroy({ name }, `seed-${String(seed)}-cleanup-${name}`);
    }
    await service.close();

    expect(await store.listAgents(), `seed=${String(seed)}`).toEqual([]);
    expect(await store.listNonterminalSends(), `seed=${String(seed)}`).toEqual([]);
    expect(await store.listPendingOperations(), `seed=${String(seed)}`).toEqual([]);
    expect(await store.listActiveIncarnations(), `seed=${String(seed)}`).toEqual([]);
    expect(pi.totalLive(), `seed=${String(seed)}`).toBe(0);
    expect(pi.starts(), `seed=${String(seed)}`).toBe(pi.ends());
    for (const name of AGENT_NAMES) {
      expect(pi.maximumFor(name), `seed=${String(seed)} name=${name}`).toBeLessThanOrEqual(1);
    }
  } catch (error: unknown) {
    throw new Error(
      `Randomized race failed for seed ${String(seed)}. Actions: ${JSON.stringify(actions)}`,
      { cause: error },
    );
  } finally {
    await service.close().catch(() => undefined);
  }
}

describe("deterministic randomized command races", () => {
  for (const seed of SEEDS) {
    it(`preserves lifecycle invariants for seed ${String(seed)}`, async () => {
      await runSeed(seed);
    });
  }
});
