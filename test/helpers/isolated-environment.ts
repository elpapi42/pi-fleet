import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface IsolatedEnvironment {
  readonly root: string;
  readonly env: NodeJS.ProcessEnv;
  cleanup(): Promise<void>;
}

export async function createIsolatedEnvironment(prefix: string): Promise<IsolatedEnvironment> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  return {
    root,
    env: {
      ...process.env,
      HOME: root,
      XDG_STATE_HOME: join(root, "state-home"),
      XDG_RUNTIME_DIR: join(root, "runtime-home"),
      XDG_DATA_HOME: join(root, "data-home"),
      PIFLEET_STATE_ROOT: join(root, "fleet-state"),
      PIFLEET_APPLICATION_ROOT: join(root, "fleet-application"),
      PIFLEET_DISABLE_REGISTERED_SERVICE: "1",
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
