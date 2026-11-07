/** Each minimum names the oldest release of the other peer this side supports. */
export interface PeerVersionDeclaration {
  protocolVersion?: string;
  minimumProtocolVersion?: string;
  runtimeVersion?: string;
  minimumRuntimeVersion?: string;
}

export interface PeerVersionCompatibility {
  status: 'compatible' | 'unverified' | 'incompatible' | 'invalid';
  compatible: boolean | undefined;
  reason?: string;
}

interface ReleaseVersion {
  major: number;
  minor: number;
  patch: number;
}

function releaseVersion(value: string): ReleaseVersion | null {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match) return null;
  const version = { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
  return Object.values(version).every(Number.isSafeInteger) ? version : null;
}

function older(version: ReleaseVersion, minimum: ReleaseVersion): boolean {
  return (
    (version.major - minimum.major ||
      version.minor - minimum.minor ||
      version.patch - minimum.patch) < 0
  );
}

/** Unknown legacy declarations cannot establish a break. No caller infers semver breaks. */
export function peerVersionCompatibility(
  local: PeerVersionDeclaration,
  peer: PeerVersionDeclaration,
  localName = 'local',
  peerName = 'peer',
): PeerVersionCompatibility {
  const missing: string[] = [];
  const declarations = [
    { name: localName, value: local, versions: new Map<string, ReleaseVersion>() },
    { name: peerName, value: peer, versions: new Map<string, ReleaseVersion>() },
  ] as const;
  for (const side of declarations) {
    for (const field of [
      'protocolVersion',
      'minimumProtocolVersion',
      'runtimeVersion',
      'minimumRuntimeVersion',
    ] as const) {
      const raw = side.value[field];
      const key = `${side.name}.${field}`;
      if (raw === undefined) {
        missing.push(key);
        continue;
      }
      const parsed = typeof raw === 'string' ? releaseVersion(raw) : null;
      if (!parsed)
        return {
          status: 'invalid',
          compatible: false,
          reason: `Invalid ${key}: expected a published major.minor.patch release.`,
        };
      side.versions.set(field, parsed);
    }
  }
  for (const [component, versionField, minimumField] of [
    ['protocol', 'protocolVersion', 'minimumProtocolVersion'],
    ['runtime', 'runtimeVersion', 'minimumRuntimeVersion'],
  ] as const) {
    for (const [side, other] of [
      [declarations[0], declarations[1]],
      [declarations[1], declarations[0]],
    ] as const) {
      const version = side.versions.get(versionField);
      const minimum = other.versions.get(minimumField);
      if (version && minimum && older(version, minimum))
        return {
          status: 'incompatible',
          compatible: false,
          reason: `${component} incompatibility: ${side.name} ${side.value[versionField]} is below ${other.name}'s declared minimum ${other.value[minimumField]}.`,
        };
    }
  }
  return missing.length
    ? {
        status: 'unverified',
        compatible: undefined,
        reason: `Peer version compatibility is unverified; missing ${missing.join(', ')}.`,
      }
    : { status: 'compatible', compatible: true };
}
