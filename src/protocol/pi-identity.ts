import { Type, type Static } from "@sinclair/typebox";

export const MANAGED_PI_ARTIFACT_ID = "@earendil-works/pi-coding-agent@0.80.10";

export const PiRuntimeIdentitySchema = Type.Union([
  Type.Object(
    {
      mode: Type.Literal("managed"),
      artifactId: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      mode: Type.Literal("external"),
      selectedPath: Type.String({ minLength: 1 }),
      nodePath: Type.String({ minLength: 1 }),
      realPath: Type.String({ minLength: 1 }),
      version: Type.String({ minLength: 1 }),
      fingerprint: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
]);

export type PiRuntimeIdentity = Static<typeof PiRuntimeIdentitySchema>;

export const MANAGED_PI_RUNTIME_IDENTITY: PiRuntimeIdentity = Object.freeze({
  mode: "managed",
  artifactId: MANAGED_PI_ARTIFACT_ID,
});

export function samePiRuntimeIdentity(left: PiRuntimeIdentity, right: PiRuntimeIdentity): boolean {
  if (left.mode !== right.mode) return false;
  if (left.mode === "managed" && right.mode === "managed") {
    return left.artifactId === right.artifactId;
  }
  if (left.mode === "external" && right.mode === "external") {
    return (
      left.selectedPath === right.selectedPath &&
      left.nodePath === right.nodePath &&
      left.realPath === right.realPath &&
      left.version === right.version &&
      left.fingerprint === right.fingerprint
    );
  }
  return false;
}
