export const RELEASE_TARGETS = Object.freeze([
  Object.freeze({ platform: "linux", arch: "x64" }),
  Object.freeze({ platform: "win32", arch: "x64" }),
  Object.freeze({ platform: "darwin", arch: "arm64" })
]);

export function releaseTargetId({ platform, arch }) {
  return `${platform}-${arch}`;
}

export function prebuiltPackageName(ownerScope, target) {
  return `@${ownerScope}/electron-overlay-prebuilt-${releaseTargetId(target)}`;
}

export function getReleaseTarget(platform = process.platform, arch = process.arch) {
  const target = RELEASE_TARGETS.find((candidate) =>
    candidate.platform === platform && candidate.arch === arch);
  if (!target) {
    throw new Error(`Unsupported release target: ${platform}-${arch}.`);
  }
  return target;
}
