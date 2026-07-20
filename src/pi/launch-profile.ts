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

function validatePersistentRpcArgv(piArgv: readonly string[]): void {
  const incompatible = piArgv.find((token) =>
    ["--mode", "--print", "-p", "--no-session", "--resume", "-r"].includes(token),
  );
  if (incompatible !== undefined) {
    throw new Error(`${incompatible} is incompatible with persistent headless Pi Fleet control`);
  }
  if (piArgv.some((token) => token.startsWith("@"))) {
    throw new Error("Pi @file prompt delivery is incompatible with Fleet-managed send ordering");
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
