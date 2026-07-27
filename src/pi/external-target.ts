import { type PiRuntimeIdentity, samePiRuntimeIdentity } from "../protocol/pi-identity.js";
import {
  ExternalPiResolutionError,
  externalPiExecutionEnvironment,
  installationIdentity,
  resolveExternalPiInstallation,
  type PiInstallation,
} from "./external-installation.js";
import { PiExecutionUnavailableError, RealPiLauncher, type PiLauncher } from "./adapter.js";

export interface ExternalPiTarget {
  readonly launcher: PiLauncher;
  readonly identity: PiRuntimeIdentity;
}

export async function createExternalPiTarget(
  env: NodeJS.ProcessEnv,
  maxStdoutFrameBytes?: number,
  maxPartialRecordBytes?: number,
): Promise<ExternalPiTarget> {
  const selectedPath = env.PIFLEET_PI_EXECUTABLE;
  const nodePath = env.PIFLEET_PI_NODE;
  if (selectedPath === undefined || nodePath === undefined) {
    return unavailableTarget(
      selectedPath ?? "<unconfigured>",
      nodePath ?? "<unconfigured>",
      "pi_not_found",
    );
  }

  let initial: PiInstallation;
  try {
    initial = await resolveExternalPiInstallation({
      env: { ...env, PIFLEET_PI_EXECUTABLE: selectedPath },
      nodePath,
    });
  } catch (error: unknown) {
    return unavailableTarget(selectedPath, nodePath, resolutionCode(error));
  }
  const identity = installationIdentity(initial);
  const launcher = new RealPiLauncher({
    executable: initial.selectedPath,
    artifactId: "external-pi",
    env: externalPiExecutionEnvironment(env, initial.selectedPath, initial.nodePath),
    ...(maxStdoutFrameBytes === undefined ? {} : { maxStdoutFrameBytes }),
    ...(maxPartialRecordBytes === undefined ? {} : { maxPartialRecordBytes }),
    preflight: async () => {
      let current: PiInstallation;
      try {
        current = await resolveExternalPiInstallation({
          env: { ...env, PIFLEET_PI_EXECUTABLE: selectedPath },
          nodePath,
        });
      } catch (error: unknown) {
        throw new PiExecutionUnavailableError(resolutionCode(error));
      }
      if (!samePiRuntimeIdentity(identity, installationIdentity(current))) {
        throw new PiExecutionUnavailableError("pi_installation_changed");
      }
    },
  });
  return { launcher, identity };
}

export { installationIdentity } from "./external-installation.js";

function unavailableTarget(
  selectedPath: string,
  nodePath: string,
  code: PiExecutionUnavailableError["code"],
): ExternalPiTarget {
  const launcher: PiLauncher = {
    artifactId: "external-pi",
    async preflight() {
      throw new PiExecutionUnavailableError(code);
    },
    async start() {
      throw new PiExecutionUnavailableError(code);
    },
  };
  return {
    launcher,
    identity: {
      mode: "external",
      selectedPath,
      nodePath,
      realPath: selectedPath,
      version: "unavailable",
      fingerprint: "unavailable",
    },
  };
}

function resolutionCode(error: unknown): PiExecutionUnavailableError["code"] {
  if (error instanceof ExternalPiResolutionError) {
    if (error.code === "invalid_arguments") return "pi_not_executable";
    return error.code;
  }
  return "pi_version_unavailable";
}
