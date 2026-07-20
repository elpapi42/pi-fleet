import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

export interface TreeIntegrity {
  readonly path: string;
  readonly files: number;
  readonly bytes: number;
  readonly sha256: string;
}

export async function hashDirectoryTree(
  root: string,
  manifestPath: string,
): Promise<TreeIntegrity> {
  const resolvedRoot = resolve(root);
  const entries = await collectFiles(resolvedRoot, resolvedRoot);
  const hash = createHash("sha256");
  let bytes = 0;
  for (const entry of entries) {
    const contents = await readFile(entry.absolutePath);
    bytes += contents.length;
    hash.update(entry.relativePath);
    hash.update("\0");
    hash.update(String(contents.length));
    hash.update("\0");
    hash.update(contents);
    hash.update("\0");
  }
  return {
    path: manifestPath,
    files: entries.length,
    bytes,
    sha256: hash.digest("hex"),
  };
}

async function collectFiles(
  root: string,
  directory: string,
): Promise<Array<{ readonly absolutePath: string; readonly relativePath: string }>> {
  const output: Array<{ absolutePath: string; relativePath: string }> = [];
  for (const name of (await readdir(directory)).sort()) {
    const absolutePath = join(directory, name);
    const linkInfo = await lstat(absolutePath);
    const info = linkInfo.isSymbolicLink() ? await stat(absolutePath) : linkInfo;
    if (info.isDirectory()) {
      if (linkInfo.isSymbolicLink()) {
        throw new Error(`Runtime dependency tree contains a directory symlink: ${absolutePath}`);
      }
      output.push(...(await collectFiles(root, absolutePath)));
      continue;
    }
    if (!info.isFile()) {
      throw new Error(`Runtime dependency tree contains an unsupported entry: ${absolutePath}`);
    }
    if (linkInfo.isSymbolicLink()) {
      const target = await realpath(absolutePath);
      if (target !== root && !target.startsWith(`${root}${sep}`)) {
        throw new Error(
          `Runtime dependency tree contains an external file symlink: ${absolutePath}`,
        );
      }
    }
    const relativePath = relative(root, absolutePath).split(sep).join("/");
    if (relativePath.length === 0 || relativePath.startsWith("../")) {
      throw new Error(`Runtime dependency path escapes its root: ${absolutePath}`);
    }
    output.push({ absolutePath, relativePath });
  }
  return output.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}
