import {
  analyzeSessionSelector,
  deriveRestorePiArgv,
  type NativeSessionSelector,
  type ObservedSession,
} from "./session-selector.js";

export interface AgentLaunchProfile {
  readonly cwd: string;
  readonly userPiArgv: readonly string[];
  readonly selector: NativeSessionSelector;
  readonly observedSession: ObservedSession | null;
  readonly restorePiArgv: readonly string[] | null;
  readonly piArtifactId: string;
}

export interface CreateLaunchProfileInput {
  readonly cwd: string;
  readonly piArgv: readonly string[];
  readonly piArtifactId: string;
}

export function createLaunchProfile(input: CreateLaunchProfileInput): AgentLaunchProfile {
  validatePersistentRpcArgv(input.piArgv);
  return {
    cwd: input.cwd,
    userPiArgv: [...input.piArgv],
    selector: analyzeSessionSelector(input.piArgv),
    observedSession: null,
    restorePiArgv: null,
    piArtifactId: input.piArtifactId,
  };
}

const PI_VALUE_OPTIONS = new Set([
  "--provider",
  "--model",
  "--api-key",
  "--system-prompt",
  "--append-system-prompt",
  "--name",
  "-n",
  "--session",
  "--session-id",
  "--fork",
  "--session-dir",
  "--models",
  "--tools",
  "-t",
  "--exclude-tools",
  "-xt",
  "--thinking",
  "--export",
  "--extension",
  "-e",
  "--skill",
  "--prompt-template",
  "--theme",
]);

const PI_BOOLEAN_OPTIONS = new Set([
  "--continue",
  "-c",
  "--help",
  "-h",
  "--version",
  "-v",
  "--no-tools",
  "-nt",
  "--no-builtin-tools",
  "-nbt",
  "--no-extensions",
  "-ne",
  "--no-skills",
  "-ns",
  "--no-prompt-templates",
  "-np",
  "--no-themes",
  "--no-context-files",
  "-nc",
  "--verbose",
  "--approve",
  "-a",
  "--no-approve",
  "-na",
  "--offline",
]);

export function validatePersistentRpcArgv(piArgv: readonly string[]): void {
  for (let index = 0; index < piArgv.length; index += 1) {
    const token = piArgv[index]!;
    if (["--mode", "--print", "-p", "--no-session", "--resume", "-r"].includes(token)) {
      throw new Error(`${token} is incompatible with persistent headless pi-fleet control`);
    }
    if (token === "--") {
      throw new Error(
        "Pi positional prompt delivery after -- is incompatible with pi-fleet send ordering",
      );
    }
    if (token.startsWith("@")) {
      throw new Error("Pi @file prompt delivery is incompatible with pi-fleet-managed send ordering");
    }
    if (PI_VALUE_OPTIONS.has(token)) {
      if (piArgv[index + 1] === undefined) throw new Error(`${token} requires a value`);
      index += 1;
      continue;
    }
    if (PI_BOOLEAN_OPTIONS.has(token) || token.includes("=")) continue;
    if (token === "--list-models") {
      const next = piArgv[index + 1];
      if (next !== undefined && !next.startsWith("-") && !next.startsWith("@")) index += 1;
      continue;
    }
    if (token.startsWith("--")) {
      const next = piArgv[index + 1];
      if (next !== undefined && !next.startsWith("-") && !next.startsWith("@")) index += 1;
      continue;
    }
    if (token.startsWith("-")) continue;
    throw new Error(
      `Pi positional prompt ${JSON.stringify(token)} is incompatible with pi-fleet send ordering`,
    );
  }
}

export function observeSession(
  profile: AgentLaunchProfile,
  session: ObservedSession,
): AgentLaunchProfile {
  return {
    ...profile,
    observedSession: session,
    restorePiArgv: deriveRestorePiArgv(profile.userPiArgv, session),
  };
}
