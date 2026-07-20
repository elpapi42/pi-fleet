import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface FleetPaths {
  readonly root: string;
  readonly socketPath: string;
}

export function resolveFleetPaths(env: NodeJS.ProcessEnv = process.env): FleetPaths {
  const explicitRoot = env.PIFLEET_STATE_ROOT;
  const root =
    explicitRoot === undefined
      ? join(env.XDG_RUNTIME_DIR ?? tmpdir(), `pifleet-${process.getuid?.() ?? "user"}`)
      : resolve(explicitRoot);
  return { root, socketPath: join(root, "control.sock") };
}
