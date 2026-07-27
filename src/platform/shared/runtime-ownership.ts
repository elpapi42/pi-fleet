import { lstat } from "node:fs/promises";
import { createConnection } from "node:net";

export type ControlSocketOwnership = "absent" | "stale" | "responsive" | "uncertain";
export type ControlSocketProbe = (
  socketPath: string,
) => Promise<Exclude<ControlSocketOwnership, "absent">>;

export class RuntimeOwnershipBlockedError extends Error {
  readonly code = "runtime_upgrade_deferred";

  constructor(message: string) {
    super(message);
    this.name = "RuntimeOwnershipBlockedError";
  }
}

export async function inspectControlSocketOwnership(
  socketPath: string,
  probe: ControlSocketProbe = probeControlSocket,
): Promise<ControlSocketOwnership> {
  const stats = await lstat(socketPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (stats === null) return "absent";
  if (!stats.isSocket()) {
    throw new RuntimeOwnershipBlockedError(
      `Refusing to replace non-socket pi-fleet control path ${socketPath}`,
    );
  }
  return probe(socketPath);
}

export async function preflightRuntimeStartup(options: {
  readonly socketPath: string;
  readonly destructive: boolean;
  readonly assertOwnedProcessTreesAbsent?: () => Promise<void>;
  readonly inspectOwnership?: typeof inspectControlSocketOwnership;
}): Promise<ControlSocketOwnership> {
  const ownership = await (options.inspectOwnership ?? inspectControlSocketOwnership)(
    options.socketPath,
  );
  if (ownership === "responsive" || ownership === "uncertain") {
    throw new RuntimeOwnershipBlockedError(
      ownership === "responsive"
        ? `A responsive pi-fleet runtime already owns ${options.socketPath}`
        : `pi-fleet control socket ownership is uncertain for ${options.socketPath}`,
    );
  }
  if (options.destructive) {
    if (options.assertOwnedProcessTreesAbsent === undefined) {
      throw new RuntimeOwnershipBlockedError(
        "Destructive pi-fleet startup requires proof that prior runtime and Pi process trees are absent.",
      );
    }
    await options.assertOwnedProcessTreesAbsent();
  }
  return ownership;
}

export function probeControlSocket(
  socketPath: string,
): Promise<Exclude<ControlSocketOwnership, "absent">> {
  return new Promise((resolveProbe) => {
    const socket = createConnection(socketPath);
    let settled = false;
    const settle = (result: Exclude<ControlSocketOwnership, "absent">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolveProbe(result);
    };
    const timer = setTimeout(() => settle("uncertain"), 200);
    socket.once("connect", () => settle("responsive"));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      settle(error.code === "ECONNREFUSED" || error.code === "ENOENT" ? "stale" : "uncertain");
    });
  });
}
