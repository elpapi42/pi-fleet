const MINIMUM_NODE_22_MINOR = 19;

export function isSupportedNodeVersion(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);

  if (match === null) {
    return false;
  }

  const major = Number(match[1]);
  const minor = Number(match[2]);

  return (major === 22 && minor >= MINIMUM_NODE_22_MINOR) || major === 24;
}
