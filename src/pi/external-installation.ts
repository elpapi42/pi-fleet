import { spawn } from "node:child_process";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { delimiter, isAbsolute, join } from "node:path";

const VERSION_TIMEOUT_MS = 3_000;
const MAX_VERSION_OUTPUT_BYTES = 4 * 1024;

export type ExternalPiResolutionErrorCode =
  | "invalid_arguments"
  | "pi_not_found"
  | "pi_not_executable"
  | "pi_version_unavailable";

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

export interface ExternalPiResolverOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly nodePath?: string;
  readonly versionCommand?: (executable: string) => Promise<string>;
}

export async function resolveExternalPiInstallation(
  options: ExternalPiResolverOptions = {},
): Promise<PiInstallation> {
  const env = options.env ?? process.env;
  const selectedPath = await resolveSelectedPath(env);
  const realPath = await inspectExecutable(selectedPath);
  const nodePath = options.nodePath ?? process.execPath;
  await inspectNode(nodePath);
  const versionOutput = await (options.versionCommand ?? readVersion)(selectedPath);
  const version = parseVersion(versionOutput);
  const targetBytes = await readFile(realPath);
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([selectedPath, realPath, version]))
    .update(targetBytes)
    .digest("hex");
  return { selectedPath, realPath, version, nodePath, fingerprint };
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

  const path = env.PATH;
  if (path === undefined || path.length === 0) {
    throw new ExternalPiResolutionError("pi_not_found", "Pi was not found on PATH.");
  }
  for (const directory of path.split(delimiter)) {
    if (!isAbsolute(directory)) {
      throw new ExternalPiResolutionError(
        "invalid_arguments",
        "PATH entries used to select Pi must be absolute paths.",
      );
    }
    const candidate = join(directory, "pi");
    try {
      await inspectExecutable(candidate);
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
  throw new ExternalPiResolutionError("pi_not_found", "Pi was not found on PATH.");
}

async function inspectExecutable(path: string): Promise<string> {
  try {
    const target = await realpath(path);
    const metadata = await stat(target);
    if (!metadata.isFile()) {
      throw new ExternalPiResolutionError("pi_not_executable", `Pi is not a file: ${path}`);
    }
    await access(path, constants.X_OK);
    return target;
  } catch (error: unknown) {
    if (error instanceof ExternalPiResolutionError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ExternalPiResolutionError("pi_not_found", `Pi was not found: ${path}`);
    }
    throw new ExternalPiResolutionError("pi_not_executable", `Pi is not executable: ${path}`);
  }
}

async function inspectNode(nodePath: string): Promise<void> {
  if (!isAbsolute(nodePath)) {
    throw new ExternalPiResolutionError("invalid_arguments", "Node must be an absolute path.");
  }
  try {
    const metadata = await stat(nodePath);
    if (!metadata.isFile()) throw new Error("not a file");
    await access(nodePath, constants.X_OK);
  } catch {
    throw new ExternalPiResolutionError("pi_not_executable", `Node is not executable: ${nodePath}`);
  }
}

async function readVersion(executable: string): Promise<string> {
  const child = spawn(executable, ["--version"], {
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = Buffer.alloc(0);
  let overflowed = false;
  child.stdout.on("data", (chunk: Buffer) => {
    if (overflowed) return;
    const next = Buffer.concat([stdout, chunk]);
    if (next.byteLength > MAX_VERSION_OUTPUT_BYTES) {
      overflowed = true;
      child.kill("SIGKILL");
      return;
    }
    stdout = next;
  });
  child.stderr.resume();

  return new Promise((resolveVersion, rejectVersion) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() =>
        rejectVersion(
          new ExternalPiResolutionError("pi_version_unavailable", "Pi version command timed out."),
        ),
      );
    }, VERSION_TIMEOUT_MS);
    child.once("error", () =>
      finish(() =>
        rejectVersion(
          new ExternalPiResolutionError("pi_version_unavailable", "Pi version command failed."),
        ),
      ),
    );
    child.once("exit", (code) => {
      if (overflowed) {
        finish(() =>
          rejectVersion(
            new ExternalPiResolutionError(
              "pi_version_unavailable",
              "Pi version output exceeded its limit.",
            ),
          ),
        );
        return;
      }
      if (code !== 0) {
        finish(() =>
          rejectVersion(
            new ExternalPiResolutionError("pi_version_unavailable", "Pi version command failed."),
          ),
        );
        return;
      }
      finish(() => resolveVersion(stdout.toString("utf8")));
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
