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
  return {
    cwd: input.cwd,
    userPiArgv: [...input.piArgv],
    selector: analyzeSessionSelector(input.piArgv),
    observedSession: null,
    restorePiArgv: null,
    piArtifactId: input.piArtifactId,
  };
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
