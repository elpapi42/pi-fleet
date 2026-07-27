import { chmodSync, constants, lstatSync } from "node:fs";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import { dirname, join, parse, resolve, sep } from "node:path";

import type { FleetPaths } from "./paths.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const GROUP_OR_OTHER_WRITE = 0o022;
const STICKY_BIT = 0o1000;
const SAFE_ROOT_STICKY_DIRECTORIES = new Set(["/tmp", "/var/tmp"]);

/** Prepare and verify paths that may retain sensitive pi-fleet state. */
export async function prepareFleetPathSecurity(paths: FleetPaths): Promise<void> {
  await preparePrivateDirectory(paths.runtimeRoot);
  if (paths.stateRoot !== paths.runtimeRoot) await preparePrivateDirectory(paths.stateRoot);
  await preparePrivateDatabase(paths.databasePath);
}

export async function preparePrivateDirectory(path: string): Promise<void> {
  const absolutePath = resolve(path);
  await prepareDirectoryComponents(absolutePath);
  const stats = await lstat(absolutePath);
  assertCurrentUser(absolutePath, stats.uid);
  await chmod(absolutePath, PRIVATE_DIRECTORY_MODE);
}

export async function preparePrivateDatabase(path: string): Promise<void> {
  const absolutePath = resolve(path);
  await preparePrivateDirectory(dirname(absolutePath));
  await assertPrivateRegularFileIfPresent(absolutePath);
  await assertPrivateRegularFileIfPresent(`${absolutePath}-wal`);
  await assertPrivateRegularFileIfPresent(`${absolutePath}-shm`);

  const handle = await open(
    absolutePath,
    constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  await handle.chmod(PRIVATE_FILE_MODE);
  await handle.close();
}

export async function hardenSqliteSidecars(path: string): Promise<void> {
  await assertPrivateRegularFileIfPresent(path, true);
  await assertPrivateRegularFileIfPresent(`${path}-wal`, true);
  await assertPrivateRegularFileIfPresent(`${path}-shm`, true);
}

export function hardenPrivateDirectorySync(path: string): void {
  assertTrustedDirectoryComponentsSync(resolve(path));
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Refusing unsafe pi-fleet directory ${path}`);
  }
  assertCurrentUser(path, stats.uid);
  chmodSync(path, PRIVATE_DIRECTORY_MODE);
}

export function hardenSqliteSidecarsSync(path: string): void {
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    let stats;
    try {
      stats = lstatSync(candidate);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error(`Refusing unsafe pi-fleet state file ${candidate}`);
    }
    assertCurrentUser(candidate, stats.uid);
    chmodSync(candidate, PRIVATE_FILE_MODE);
  }
}

function assertTrustedDirectoryComponentsSync(absolutePath: string): void {
  const root = parse(absolutePath).root;
  let current = root;
  const rootStats = lstatSync(root);
  assertTrustedDirectoryAncestor(root, rootStats.uid, rootStats.mode);
  for (const component of absolutePath.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, component);
    const stats = lstatSync(current);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`Refusing unsafe pi-fleet directory ${current}`);
    }
    assertTrustedDirectoryAncestor(current, stats.uid, stats.mode);
  }
}

async function prepareDirectoryComponents(absolutePath: string): Promise<void> {
  const root = parse(absolutePath).root;
  const rootStats = await lstat(root);
  assertTrustedDirectoryAncestor(root, rootStats.uid, rootStats.mode);
  const components = absolutePath.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  for (const component of components) {
    current = join(current, component);
    let stats = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (stats === null) {
      await mkdir(current, { mode: PRIVATE_DIRECTORY_MODE }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        },
      );
      stats = await lstat(current);
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`Refusing unsafe pi-fleet directory symlink ${current}`);
    }
    if (!stats.isDirectory()) {
      throw new Error(`Refusing unsafe pi-fleet directory ${current}`);
    }
    assertTrustedDirectoryAncestor(current, stats.uid, stats.mode);
  }
}

export function assertTrustedDirectoryAncestor(
  path: string,
  ownerUid: number,
  mode: number,
  currentUid = process.getuid?.(),
): void {
  if (currentUid === undefined || ownerUid === currentUid) return;
  if (ownerUid === 0) {
    const writable = (mode & GROUP_OR_OTHER_WRITE) !== 0;
    if (!writable) return;
    if ((mode & STICKY_BIT) !== 0 && SAFE_ROOT_STICKY_DIRECTORIES.has(path)) return;
  }
  throw new Error(`Refusing untrusted pi-fleet directory ancestor: ${path}`);
}

async function assertPrivateRegularFileIfPresent(path: string, harden = false): Promise<void> {
  const stats = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (stats === null) return;
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`Refusing unsafe pi-fleet state file ${path}`);
  }
  assertCurrentUser(path, stats.uid);
  if (harden || (stats.mode & 0o077) !== 0) await chmod(path, PRIVATE_FILE_MODE);
}

function assertCurrentUser(path: string, ownerUid: number): void {
  const uid = process.getuid?.();
  if (uid !== undefined && ownerUid !== uid) {
    throw new Error(`Refusing pi-fleet path not owned by the current user: ${path}`);
  }
}
