import { listFiles, parse as parseDotenvFiles } from 'dotenv-flow';
import type { ConfigContext, ExpoConfig } from 'expo/config';
import Joi from 'joi';

import packageJson from './package.json';

type AppVariant = 'development' | 'preview' | 'production';

interface VariantConfig {
  displayName: string;
  identifierSuffix: string;
  schemeSuffix: string;
  icon: string;
  accentColor: string;
}

const VARIANT_CONFIG: Record<AppVariant, VariantConfig> = {
  development: {
    displayName: 'Farmslot Dev',
    identifierSuffix: '.development',
    schemeSuffix: '-development',
    icon: './assets/icon-development.png',
    accentColor: '#DC143C',
  },
  preview: {
    displayName: 'Farmslot Preview',
    identifierSuffix: '.preview',
    schemeSuffix: '-preview',
    icon: './assets/icon-preview.png',
    accentColor: '#F59E0B',
  },
  production: {
    displayName: 'Farmslot',
    identifierSuffix: '',
    schemeSuffix: '',
    icon: './assets/icon-production.png',
    accentColor: '#6366F1',
  },
};

interface AppConfigEnv {
  APP_VARIANT: AppVariant;
  SITEED_BUNDLE_BASE: string;
  SITEED_SCHEME_BASE: string;
  BUNDLE_ID: string;
  SCHEME: string;
  EAS_PROJECT_ID: string;
  EXPO_PUBLIC_GATEWAY_URL: string;
  FARMSLOT_REMOTE_GATEWAY_URL: string;
  FARMSLOT_GATEWAY_TOKEN: string;
  FARMSLOT_REMOTE_GATEWAY_TOKEN: string;
  EXPO_PUBLIC_SHERPA_ASR_MODEL_DIR: string;
  EXPO_PUBLIC_SHERPA_ASR_MODEL_ID: string;
}

const envSchema = Joi.object({
  APP_VARIANT: Joi.string().valid('development', 'preview', 'production').default('development'),
  SITEED_BUNDLE_BASE: Joi.string().default('net.siteed.farmslot'),
  SITEED_SCHEME_BASE: Joi.string().default('farmslot'),
  BUNDLE_ID: Joi.string().allow('').default(''),
  SCHEME: Joi.string().allow('').default(''),
  EAS_PROJECT_ID: Joi.string().uuid().default('5673e87d-de68-4685-9d17-03533e7d63de'),
  EXPO_PUBLIC_GATEWAY_URL: Joi.string().allow('').default(''),
  FARMSLOT_REMOTE_GATEWAY_URL: Joi.string().allow('').default(''),
  FARMSLOT_GATEWAY_TOKEN: Joi.string().allow('').default(''),
  FARMSLOT_REMOTE_GATEWAY_TOKEN: Joi.string().allow('').default(''),
  EXPO_PUBLIC_SHERPA_ASR_MODEL_DIR: Joi.string().allow('').default(''),
  EXPO_PUBLIC_SHERPA_ASR_MODEL_ID: Joi.string().allow('').default(''),
}).unknown();

// Keep one canonical Expo slug for the linked EAS project. Install identity and
// deep-link disambiguation come from bundle/package IDs and schemes, not slug.
const APP_SLUG = 'farmslot';
const APP_VERSION = packageJson.version;

function loadEnv(): AppConfigEnv {
  const requestedVariant = process.env.APP_VARIANT || 'development';
  const dotenvEnv = parseDotenvFiles(
    listFiles({
      node_env: requestedVariant,
      path: process.cwd(),
    }),
  );
  const rawEnv = {
    ...process.env,
    ...dotenvEnv,
    APP_VARIANT: requestedVariant,
  };

  const { value, error } = envSchema.validate(rawEnv) as {
    value: AppConfigEnv;
    error?: Joi.ValidationError;
  };
  if (error) {
    console.error('Invalid environment variables:', error.message);
    process.exit(1);
  }
  return value;
}

function appIdentity(env: AppConfigEnv) {
  const variant = env.APP_VARIANT;
  const variantInfo = VARIANT_CONFIG[variant];
  const defaultAppIdentifier = `${env.SITEED_BUNDLE_BASE}${variantInfo.identifierSuffix}`;
  const defaultAppScheme = `${env.SITEED_SCHEME_BASE}${variantInfo.schemeSuffix}`;
  return {
    appIdentifier: env.BUNDLE_ID || defaultAppIdentifier,
    appScheme: env.SCHEME || defaultAppScheme,
    variant,
    variantInfo,
  };
}

function parsePositivePort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export default ({ config }: ConfigContext): ExpoConfig => {
  const env = loadEnv();
  const { appIdentifier, appScheme, variant, variantInfo } = appIdentity(env);
  const isProduction = variant === 'production';
  const metroPort = parsePositivePort(process.env.METRO_PORT ?? process.env.WATCHER_PORT, 7677);
  const remoteGatewayToken = env.FARMSLOT_REMOTE_GATEWAY_TOKEN || env.FARMSLOT_GATEWAY_TOKEN;

  return {
    ...config,
    name: variantInfo.displayName,
    slug: APP_SLUG,
    version: APP_VERSION,
    orientation: 'default',
    icon: variantInfo.icon,
    scheme: appScheme,
    userInterfaceStyle: 'dark',
    ios: {
      bundleIdentifier: appIdentifier,
      supportsTablet: true,
      infoPlist: {
        ITSAppUsesNonExemptEncryption: false,
        NSMicrophoneUsageDescription:
          'Farmslot uses the microphone only when you tap Record to draft a worker instruction with on-device voice transcription.',
        NSCameraUsageDescription:
          'Farmslot uses the camera only when you scan a Command Center QR code to pair a gateway profile.',
        NSAppTransportSecurity: {
          NSAllowsLocalNetworking: true,
          NSExceptionDomains: {
            'ts.net': {
              NSIncludesSubdomains: true,
              NSExceptionAllowsInsecureHTTPLoads: true,
            },
          },
        },
      },
    },
    android: {
      package: appIdentifier,
      permissions: ['android.permission.CAMERA'],
      adaptiveIcon: {
        foregroundImage: variantInfo.icon,
        backgroundColor: variantInfo.accentColor,
      },
    },
    plugins: [
      'expo-router',
      'expo-asset',
      'expo-font',
      [
        'expo-splash-screen',
        {
          image: variantInfo.icon,
          resizeMode: 'contain',
          backgroundColor: variantInfo.accentColor,
        },
      ],
      'expo-status-bar',
      'expo-video',
      ['expo-screen-orientation', { initialOrientation: 'DEFAULT' }],
      'expo-secure-store',
      [
        'expo-camera',
        {
          cameraPermission:
            'Farmslot uses the camera only when you scan a Command Center QR code to pair a gateway profile.',
        },
      ],
      [
        '@siteed/audio-studio',
        {
          enableBackgroundAudio: false,
          enableDeviceDetection: false,
          enableNotifications: false,
          enablePhoneStateHandling: false,
          microphonePermission:
            'Farmslot uses the microphone only when you tap Record to draft a worker instruction with on-device voice transcription.',
          iosBackgroundModes: {
            useAudio: false,
            useExternalAccessory: false,
            useLocation: false,
            useProcessing: false,
            useVoIP: false,
          },
        },
      ],
      '@siteed/sherpa-onnx.rn',
      // Android writes this into generated native files at prebuild time; rerun prebuild if
      // changing METRO_PORT for Android. iOS gets the port dynamically via RCT_METRO_PORT.
      ['./plugins/withMetroPort.cjs', { port: metroPort, usesCleartextTraffic: true }],
    ],
    updates: {
      url: `https://u.expo.dev/${env.EAS_PROJECT_ID}`,
      enabled: true,
      useEmbeddedUpdate: true,
      checkAutomatically: 'ON_LOAD',
      fallbackToCacheTimeout: 0,
    },
    runtimeVersion: {
      policy: 'appVersion',
    },
    extra: {
      eas: {
        projectId: env.EAS_PROJECT_ID,
      },
      gatewayUrl: env.EXPO_PUBLIC_GATEWAY_URL,
      remoteGatewayUrl: env.FARMSLOT_REMOTE_GATEWAY_URL,
      gatewayAuthToken: !isProduction ? remoteGatewayToken : '',
      sherpaAsrModelDir: env.EXPO_PUBLIC_SHERPA_ASR_MODEL_DIR,
      sherpaAsrModelId: env.EXPO_PUBLIC_SHERPA_ASR_MODEL_ID,
      appVariant: variant,
      appIdentifier: appIdentifier,
      appScheme: appScheme,
      appSlug: APP_SLUG,
      appDisplayName: variantInfo.displayName,
      appAccentColor: variantInfo.accentColor,
      metroPort: metroPort,
    },
  };
};
