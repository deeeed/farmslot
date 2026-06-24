import Constants from 'expo-constants';

import { colors } from './theme';

export interface CompanionExpoExtra {
  appVariant?: string;
  appIdentifier?: string;
  appScheme?: string;
  appSlug?: string;
  appDisplayName?: string;
  appAccentColor?: string;
  gatewayUrl?: string;
  remoteGatewayUrl?: string;
  metroPort?: number | string;
}

export interface CompanionEnvironment {
  appVariant: string;
  appIdentifier: string;
  appScheme: string;
  appSlug: string;
  appDisplayName: string;
  appAccentColor: string;
  appVersion: string;
  nativeBuildVersion: string;
  gatewayUrl: string;
  remoteGatewayUrl: string;
  metroPort: string;
  updateUrl: string;
  runtimeVersion: string;
  isProduction: boolean;
}

export function formatCompanionVersionSubtitle(env: CompanionEnvironment): string {
  const parts = [`v${env.appVersion}`, env.appVariant];
  if (env.nativeBuildVersion) {
    parts.push(`build ${env.nativeBuildVersion}`);
  } else if (env.runtimeVersion !== 'unset' && !env.runtimeVersion.startsWith('policy:')) {
    parts.push(`runtime ${env.runtimeVersion}`);
  }
  return parts.join(' · ');
}

export function getCompanionEnvironment(): CompanionEnvironment {
  const expoConfig = Constants.expoConfig;
  const extra = expoConfig?.extra as CompanionExpoExtra | undefined;
  const appVariant = extra?.appVariant ?? 'development';

  return {
    appVariant,
    appIdentifier: extra?.appIdentifier ?? 'unknown',
    appScheme: extra?.appScheme ? `${extra.appScheme}://` : 'unknown',
    appSlug: extra?.appSlug ?? expoConfig?.slug ?? 'unknown',
    appDisplayName: extra?.appDisplayName ?? expoConfig?.name ?? 'Farmslot',
    appAccentColor: extra?.appAccentColor ?? colors.accent,
    appVersion: expoConfig?.version ?? 'unknown',
    nativeBuildVersion: Constants.nativeBuildVersion ?? '',
    gatewayUrl: extra?.gatewayUrl ?? 'unset',
    remoteGatewayUrl: extra?.remoteGatewayUrl ?? 'unset',
    metroPort: extra?.metroPort == null ? 'unknown' : String(extra.metroPort),
    updateUrl: expoConfig?.updates?.url ?? 'unset',
    runtimeVersion: formatRuntimeVersion(expoConfig?.runtimeVersion),
    isProduction: appVariant === 'production',
  };
}

function formatRuntimeVersion(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'policy' in value) {
    const policy = (value as { policy?: unknown }).policy;
    return typeof policy === 'string' ? `policy:${policy}` : 'policy:unknown';
  }
  return 'unset';
}
