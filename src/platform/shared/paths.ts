import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface FleetPaths {
  readonly runtimeRoot: string;
  readonly stateRoot: string;
  readonly socketPath: string;
  readonly databasePath: string;
}

export function resolveFleetPaths(env: NodeJS.ProcessEnv = process.env): FleetPaths {
  const explicitRoot = env.PIFLEET_STATE_ROOT;
  if (explicitRoot !== undefined) {
    const root = resolve(explicitRoot);
    return {
      runtimeRoot: root,
      stateRoot: root,
      socketPath: join(root, "control.sock"),
      databasePath: join(root, "fleet.sqlite"),
    };
  }

  const runtimeRoot = join(
    env.XDG_RUNTIME_DIR ?? tmpdir(),
    `pifleet-${process.getuid?.() ?? "user"}`,
  );
  const stateRoot =
    process.platform === "darwin"
      ? join(homedir(), "Library", "Application Support", "Pi Fleet")
      : join(env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "pi-fleet");
  return {
    runtimeRoot,
    stateRoot,
    socketPath: join(runtimeRoot, "control.sock"),
    databasePath: join(stateRoot, "fleet.sqlite"),
  };
}
