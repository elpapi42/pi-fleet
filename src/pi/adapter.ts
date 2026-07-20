import type { AgentLaunchProfile } from "./launch-profile.js";
import { PiProcess } from "./process.js";

export interface PiLauncher {
  readonly artifactId: string;
  start(profile: AgentLaunchProfile, restore: boolean): Promise<PiProcess>;
}

export interface RealPiLauncherOptions {
  readonly executable: string;
  readonly artifactId: string;
  readonly argvPrefix?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly onStart?: (pid: number) => void;
}

export class RealPiLauncher implements PiLauncher {
  readonly artifactId: string;

  constructor(private readonly options: RealPiLauncherOptions) {
    this.artifactId = options.artifactId;
  }

  async start(profile: AgentLaunchProfile, restore: boolean): Promise<PiProcess> {
    const piArgv = restore ? profile.restorePiArgv : profile.userPiArgv;
    if (piArgv === null) throw new Error("Agent has no observed Pi session to restore");
    const process = await PiProcess.start({
      executable: this.options.executable,
      ...(this.options.argvPrefix === undefined ? {} : { argvPrefix: this.options.argvPrefix }),
      piArgv,
      cwd: profile.cwd,
      ...(this.options.env === undefined ? {} : { env: this.options.env }),
    });
    this.options.onStart?.(process.pid);
    return process;
  }
}
