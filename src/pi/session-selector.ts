export type NativeSessionSelector =
  | { readonly kind: "none" }
  | { readonly kind: "session"; readonly value: string }
  | { readonly kind: "session-id"; readonly value: string }
  | { readonly kind: "fork"; readonly value: string }
  | { readonly kind: "continue" }
  | { readonly kind: "resume" };

export interface ObservedSession {
  readonly path: string | null;
  readonly id: string;
}

interface SelectorMatch {
  readonly selector: NativeSessionSelector;
  readonly start: number;
  readonly length: number;
}

const VALUE_SELECTORS = new Map<string, "session" | "session-id" | "fork">([
  ["--session", "session"],
  ["--session-id", "session-id"],
  ["--fork", "fork"],
]);

const BOOLEAN_SELECTORS = new Map<string, "continue" | "resume">([
  ["--continue", "continue"],
  ["-c", "continue"],
  ["--resume", "resume"],
  ["-r", "resume"],
]);

function findSelectorMatches(argv: readonly string[]): SelectorMatch[] {
  const matches: SelectorMatch[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;

    const valueKind = VALUE_SELECTORS.get(token);
    if (valueKind !== undefined) {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error(`${token} requires a value`);
      }
      matches.push({ selector: { kind: valueKind, value }, start: index, length: 2 });
      index += 1;
      continue;
    }

    const booleanKind = BOOLEAN_SELECTORS.get(token);
    if (booleanKind !== undefined) {
      matches.push({ selector: { kind: booleanKind }, start: index, length: 1 });
    }
  }

  return matches;
}

export function analyzeSessionSelector(argv: readonly string[]): NativeSessionSelector {
  const matches = findSelectorMatches(argv);
  if (matches.length === 0) return { kind: "none" };
  if (matches.length > 1) {
    throw new Error("Conflicting Pi session selectors are not supported");
  }
  return matches[0]!.selector;
}

export function deriveRestorePiArgv(
  userPiArgv: readonly string[],
  observedSession: ObservedSession,
): readonly string[] {
  const matches = findSelectorMatches(userPiArgv);
  if (matches.length > 1) {
    throw new Error("Conflicting Pi session selectors are not supported");
  }

  const selector = matches[0]?.selector ?? { kind: "none" as const };
  if (selector.kind === "session" || selector.kind === "session-id") {
    return [...userPiArgv];
  }

  if (observedSession.path === null) {
    throw new Error("Pi did not report the concrete session path required for restoration");
  }

  const selectorMatch = matches[0];
  const retainedArgv = userPiArgv.filter((_token, index) => {
    if (selectorMatch === undefined) return true;
    return index < selectorMatch.start || index >= selectorMatch.start + selectorMatch.length;
  });

  return [...retainedArgv, "--session", observedSession.path];
}
