import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { createReadStream } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join } from "node:path";

import type { PiRuntimeIdentity } from "../protocol/pi-identity.js";

const VERSION_TIMEOUT_MS = 3_000;
const MAX_VERSION_OUTPUT_BYTES = 4 * 1024;

export type ExternalPiResolutionErrorCode =
  | "invalid_arguments"
  | "pi_not_found"
  | "pi_not_executable"
  | "pi_version_unavailable"
  | "pi_installation_changed";

export class ExternalPiResolutionError extends Error {
  constructor(
    readonly code: ExternalPiResolutionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ExternalPiResolutionError";
  }
}

export interface PiInstallation {
  readonly selectedPath: string;
  readonly realPath: string;
  readonly version: string;
  readonly nodePath: string;
  readonly fingerprint: string;
}

export function installationIdentity(installation: PiInstallation): PiRuntimeIdentity {
  return {
    mode: "external",
    selectedPath: installation.selectedPath,
    nodePath: installation.nodePath,
    realPath: installation.realPath,
    version: installation.version,
    fingerprint: installation.fingerprint,
  };
}

export interface ExternalPiResolverOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly nodePath?: string;
  readonly versionCommand?: (executable: string) => Promise<string>;
  readonly versionTimeoutMs?: number;
  readonly maxVersionOutputBytes?: number;
}

export async function resolveExternalPiInstallation(
  options: ExternalPiResolverOptions = {},
): Promise<PiInstallation> {
  const env = options.env ?? process.env;
  const selectedPath = await resolveSelectedPath(env);
  const nodePath = options.nodePath ?? (await resolveNodePath(env));
  await inspectNode(nodePath);

  const executionEnv = externalPiExecutionEnvironment(env, selectedPath, nodePath);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const observation = await observeInstallation(selectedPath, executionEnv, options);
    if (observation !== null) {
      return {
        selectedPath,
        nodePath,
        ...observation,
      };
    }
  }

  throw new ExternalPiResolutionError(
    "pi_installation_changed",
    "Pi changed while its installation was being observed.",
  );
}

export function externalPiExecutionEnvironment(
  env: NodeJS.ProcessEnv,
  selectedPath: string,
  nodePath: string,
): NodeJS.ProcessEnv {
  return {
    ...env,
    PATH: [dirname(nodePath), dirname(selectedPath), env.PATH]
      .filter((value): value is string => value !== undefined && value.length > 0)
      .join(delimiter),
  };
}

async function observeInstallation(
  selectedPath: string,
  env: NodeJS.ProcessEnv,
  options: ExternalPiResolverOptions,
): Promise<Omit<PiInstallation, "selectedPath" | "nodePath"> | null> {
  const beforeRealPath = await inspectExecutable(selectedPath, "Pi");
  const beforeHash = await hashFile(beforeRealPath);
  const versionOutput = await (
    options.versionCommand ??
    ((executable: string) =>
      readVersion(executable, env, options.versionTimeoutMs, options.maxVersionOutputBytes))
  )(selectedPath);
  const version = parseVersion(versionOutput);
  const afterRealPath = await inspectExecutable(selectedPath, "Pi");
  const afterHash = await hashFile(afterRealPath);

  if (beforeRealPath !== afterRealPath || beforeHash !== afterHash) return null;

  return {
    realPath: afterRealPath,
    version,
    fingerprint: createHash("sha256")
      .update(JSON.stringify([selectedPath, afterRealPath, version, afterHash]))
      .digest("hex"),
  };
}

async function resolveSelectedPath(env: NodeJS.ProcessEnv): Promise<string> {
  const explicit = env.PIFLEET_PI_EXECUTABLE;
  if (explicit !== undefined) {
    if (!isAbsolute(explicit)) {
      throw new ExternalPiResolutionError(
        "invalid_arguments",
        "PIFLEET_PI_EXECUTABLE must be an absolute path.",
      );
    }
    return explicit;
  }
  return resolvePathExecutable(env, "pi", "Pi", "pi_not_found");
}

async function resolveNodePath(env: NodeJS.ProcessEnv): Promise<string> {
  return resolvePathExecutable(env, "node", "Node", "pi_not_executable");
}

async function resolvePathExecutable(
  env: NodeJS.ProcessEnv,
  name: string,
  label: "Pi" | "Node",
  missingCode: "pi_not_found" | "pi_not_executable",
): Promise<string> {
  const path = env.PATH;
  if (path === undefined || path.length === 0) {
    throw new ExternalPiResolutionError(missingCode, `${label} was not found on PATH.`);
  }
  for (const directory of path.split(delimiter)) {
    if (!isAbsolute(directory)) {
      throw new ExternalPiResolutionError(
        "invalid_arguments",
        `PATH entries used to select ${label} must be absolute paths.`,
      );
    }
    const candidate = join(directory, name);
    try {
      await inspectExecutable(candidate, label);
      return candidate;
    } catch (error: unknown) {
      if (
        !(error instanceof ExternalPiResolutionError) ||
        (error.code !== "pi_not_executable" && error.code !== "pi_not_found")
      ) {
        throw error;
      }
    }
  }
  throw new ExternalPiResolutionError(missingCode, `${label} was not found on PATH.`);
}

async function inspectExecutable(path: string, label: "Pi" | "Node"): Promise<string> {
  try {
    const target = await realpath(path);
    const metadata = await stat(target);
    if (!metadata.isFile()) {
      throw new ExternalPiResolutionError("pi_not_executable", `${label} is not a file: ${path}`);
    }
    await access(path, constants.X_OK);
    return target;
  } catch (error: unknown) {
    if (error instanceof ExternalPiResolutionError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ExternalPiResolutionError("pi_not_found", `${label} was not found: ${path}`);
    }
    throw new ExternalPiResolutionError("pi_not_executable", `${label} is not executable: ${path}`);
  }
}

async function inspectNode(nodePath: string): Promise<void> {
  if (!isAbsolute(nodePath)) {
    throw new ExternalPiResolutionError("invalid_arguments", "Node must be an absolute path.");
  }
  try {
    await inspectExecutable(nodePath, "Node");
  } catch {
    throw new ExternalPiResolutionError("pi_not_executable", `Node is not executable: ${nodePath}`);
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolveHash, rejectHash) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk: string | Buffer) => hash.update(chunk));
    stream.once("error", rejectHash);
    stream.once("end", resolveHash);
  });
  return hash.digest("hex");
}

async function readVersion(
  executable: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = VERSION_TIMEOUT_MS,
  maxOutputBytes = MAX_VERSION_OUTPUT_BYTES,
): Promise<string> {
  const child = spawn(executable, ["--version"], {
    detached: process.platform !== "win32",
    env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const chunks: Buffer[] = [];
  let outputBytes = 0;
  let terminalError: ExternalPiResolutionError | null = null;
  let terminated = false;

  const terminate = () => {
    if (terminated) return;
    terminated = true;
    if (process.platform !== "win32" && child.pid !== undefined) {
      try {
        process.kill(-child.pid, "SIGKILL");
        return;
      } catch {
        // The group may have already exited; kill the direct child as a fallback.
      }
    }
    child.kill("SIGKILL");
  };

  child.stdout.on("data", (chunk: Buffer) => {
    if (terminalError !== null) return;
    outputBytes += chunk.byteLength;
    if (outputBytes > maxOutputBytes) {
      terminalError = new ExternalPiResolutionError(
        "pi_version_unavailable",
        "Pi version output exceeded its limit.",
      );
      terminate();
      return;
    }
    chunks.push(chunk);
  });
  child.stderr.resume();

  return new Promise((resolveVersion, rejectVersion) => {
    const timer = setTimeout(() => {
      terminalError = new ExternalPiResolutionError(
        "pi_version_unavailable",
        "Pi version command timed out.",
      );
      terminate();
    }, timeoutMs);
    child.once("error", () => {
      terminalError ??= new ExternalPiResolutionError(
        "pi_version_unavailable",
        "Pi version command failed.",
      );
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (terminalError !== null) {
        rejectVersion(terminalError);
        return;
      }
      if (code !== 0) {
        rejectVersion(
          new ExternalPiResolutionError("pi_version_unavailable", "Pi version command failed."),
        );
        return;
      }
      try {
        resolveVersion(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
      } catch {
        rejectVersion(
          new ExternalPiResolutionError(
            "pi_version_unavailable",
            "Pi version command returned invalid UTF-8.",
          ),
        );
      }
    });
  });
}

function parseVersion(output: string): string {
  const match = /^(?:pi\s+)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s*$/i.exec(output);
  if (match?.[1] === undefined) {
    throw new ExternalPiResolutionError(
      "pi_version_unavailable",
      "Pi version command returned an invalid version.",
    );
  }
  return match[1];
}
