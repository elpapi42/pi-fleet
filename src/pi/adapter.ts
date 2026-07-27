import type { AgentLaunchProfile } from "./launch-profile.js";
import { PiProcess } from "./process.js";

export type { PiDeliveryMode } from "./process.js";

export type PiStdoutSink = (record: Buffer) => void | Promise<void>;

export type PiExecutionUnavailableCode =
  | "pi_not_found"
  | "pi_not_executable"
  | "pi_version_unavailable"
  | "pi_version_unsupported"
  | "pi_installation_changed";

export class PiExecutionUnavailableError extends Error {
  constructor(readonly code: PiExecutionUnavailableCode) {
    super(code);
    this.name = "PiExecutionUnavailableError";
  }
}

export interface PiLauncher {
  readonly artifactId: string;
  preflight?(): Promise<void>;
  start(
    profile: AgentLaunchProfile,
    restore: boolean,
    onSpawn?: (pid: number) => Promise<void>,
    onStdoutRecord?: PiStdoutSink,
  ): Promise<PiProcess>;
}

export interface RealPiLauncherOptions {
  readonly executable: string;
  readonly artifactId: string;
  readonly argvPrefix?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly onStart?: (pid: number) => void;
  readonly maxStdoutFrameBytes?: number;
  readonly maxPartialRecordBytes?: number;
  readonly preflight?: () => Promise<void>;
}

export class RealPiLauncher implements PiLauncher {
  readonly artifactId: string;

  constructor(private readonly options: RealPiLauncherOptions) {
    this.artifactId = options.artifactId;
  }

  preflight(): Promise<void> {
    return this.options.preflight?.() ?? Promise.resolve();
  }

  async start(
    profile: AgentLaunchProfile,
    restore: boolean,
    onSpawn?: (pid: number) => Promise<void>,
    onStdoutRecord?: PiStdoutSink,
  ): Promise<PiProcess> {
    const piArgv = restore ? profile.restorePiArgv : profile.userPiArgv;
    if (piArgv === null) throw new Error("Agent has no observed Pi session to restore");
    const process = await PiProcess.start({
      executable: this.options.executable,
      ...(this.options.argvPrefix === undefined ? {} : { argvPrefix: this.options.argvPrefix }),
      piArgv,
      cwd: profile.cwd,
      ...(this.options.env === undefined ? {} : { env: this.options.env }),
      ...(this.options.maxStdoutFrameBytes === undefined
        ? {}
        : { maxStdoutFrameBytes: this.options.maxStdoutFrameBytes }),
      ...(this.options.maxPartialRecordBytes === undefined
        ? {}
        : { maxPartialRecordBytes: this.options.maxPartialRecordBytes }),
      ...(onSpawn === undefined ? {} : { onSpawn }),
      ...(onStdoutRecord === undefined ? {} : { onStdoutRecord }),
    });
    this.options.onStart?.(process.pid);
    return process;
  }
}
