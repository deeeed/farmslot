#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

missing=0
repair_needed=0

require_file() {
  local path="$1"
  local hint="$2"
  if [[ ! -f "$path" ]]; then
    echo "[doctor:ios] missing required build input: $path" >&2
    echo "[doctor:ios] hint: $hint" >&2
    missing=1
  fi
}

mark_repair_needed() {
  local message="$1"
  local hint="$2"
  echo "[doctor:ios] ${message}" >&2
  echo "[doctor:ios] hint: ${hint}" >&2
  repair_needed=1
}

package_version() {
  local package_name="$1"
  node -e "process.stdout.write(require('${package_name}/package.json').version)" 2>/dev/null || true
}

major_minor() {
  local version="$1"
  echo "${version}" | awk -F. '{ print $1 "." $2 }'
}

expo_config_value() {
  local key_path="$1"
  yarn expo config --type public --json 2>/dev/null | node -e "
const fs = require('fs');
const config = JSON.parse(fs.readFileSync(0, 'utf8'));
const value = '${key_path}'.split('.').reduce((current, key) => current?.[key], config);
if (typeof value === 'string') process.stdout.write(value);
"
}

plist_value() {
  local plist_path="$1"
  local key="$2"
  plutil -extract "${key}" raw "${plist_path}" 2>/dev/null || true
}

require_file "node_modules/typescript/bin/tsc" \
  "run 'cd apps/companion && yarn install' to restore Yarn node_modules links"

expo_version="$(package_version expo)"
react_native_version="$(package_version react-native)"
pod_expo_version=""
if [[ -f ios/Podfile.lock ]]; then
  pod_expo_version="$(sed -nE 's/^  - Expo \(([0-9]+[.][0-9]+[.][^)]+)\):/\1/p' ios/Podfile.lock | head -1)"
fi

if [[ -n "${expo_version}" && -n "${pod_expo_version}" ]] &&
  [[ "$(major_minor "${expo_version}")" != "$(major_minor "${pod_expo_version}")" ]]; then
  mark_repair_needed \
    "native iOS pods are out of sync with Expo JS packages (Pods Expo ${pod_expo_version}, package Expo ${expo_version})" \
    "run 'cd apps/companion && APP_VARIANT=development yarn expo prebuild --platform ios --clean'"
fi

expected_updates_url="$(expo_config_value updates.url || true)"
expected_runtime_version="$(expo_config_value runtimeVersion || true)"
generated_expo_plist=""
if [[ -d ios ]]; then
  generated_expo_plist="$(find ios -path "*/Supporting/Expo.plist" -print -quit)"
fi
if [[ -n "${generated_expo_plist}" ]]; then
  generated_updates_url="$(plist_value "${generated_expo_plist}" EXUpdatesURL)"
  generated_runtime_version="$(plist_value "${generated_expo_plist}" EXUpdatesRuntimeVersion)"
  if [[ -n "${expected_updates_url}" && "${generated_updates_url}" != "${expected_updates_url}" ]]; then
    mark_repair_needed \
      "generated iOS Expo.plist has stale EAS Update URL (${generated_updates_url:-missing}, expected ${expected_updates_url})" \
      "run 'cd apps/companion && APP_VARIANT=development yarn expo prebuild --platform ios --clean'"
  fi
  if [[ -n "${expected_runtime_version}" && "${generated_runtime_version}" != "${expected_runtime_version}" ]]; then
    mark_repair_needed \
      "generated iOS Expo.plist has stale runtimeVersion (${generated_runtime_version:-missing}, expected ${expected_runtime_version})" \
      "run 'cd apps/companion && APP_VARIANT=development yarn expo prebuild --platform ios --clean'"
  fi
fi

fabric_provider_base="node_modules/react-native/React/Fabric/RCTThirdPartyFabricComponentsProvider"
if [[ ! -f "${fabric_provider_base}.mm" || ! -f "${fabric_provider_base}.h" ]]; then
  # RN 0.82+ no longer ships these files in the package. Stale SDK 52/old-arch Pods
  # can still reference them and fail Xcode with "Build input file cannot be found".
  if [[ -f ios/Pods/Pods.xcodeproj/project.pbxproj ]] &&
    grep -q "RCTThirdPartyFabricComponentsProvider" ios/Pods/Pods.xcodeproj/project.pbxproj; then
    mark_repair_needed \
      "stale CocoaPods project still references removed React Native Fabric provider files" \
      "run 'cd apps/companion && APP_VARIANT=development yarn expo prebuild --platform ios --clean'"
  fi
fi

pods_present=1
if [[ ! -d ios/Pods ]]; then
  pods_present=0
  echo "[doctor:ios] ios/Pods not present yet; Expo may generate/install native pods during run:ios" >&2
  echo "[doctor:ios] hint: if Xcode later fails on Pods, run 'cd apps/companion/ios && pod install' or 'cd apps/companion && yarn prebuild'" >&2
fi

if [[ "${missing}" -ne 0 ]]; then
  exit 1
fi

if [[ "${repair_needed}" -ne 0 ]]; then
  exit 10
fi

verbose=0
for arg in "$@"; do
  if [[ "$arg" == "--verbose" ]]; then
    verbose=1
  fi
done

if [[ "$verbose" -eq 1 ]]; then
  if [[ -f "${fabric_provider_base}.mm" && -f "${fabric_provider_base}.h" ]]; then
    echo "[doctor:ios] React Native packaged Fabric provider exists"
  else
    echo "[doctor:ios] React Native ${react_native_version:-unknown} does not ship legacy Fabric provider files; no stale Pods reference found"
  fi
  echo "[doctor:ios] TypeScript binary exists"
  if [[ -n "${expo_version}" ]]; then
    echo "[doctor:ios] Expo package version ${expo_version}"
  fi
  if [[ -n "${pod_expo_version}" ]]; then
    echo "[doctor:ios] iOS Podfile.lock Expo version ${pod_expo_version}"
  fi
  if [[ -n "${expected_updates_url}" ]]; then
    echo "[doctor:ios] Expected EAS Update URL ${expected_updates_url}"
  fi
  if [[ -n "${generated_expo_plist}" ]]; then
    echo "[doctor:ios] Generated Expo.plist ${generated_expo_plist}"
  fi
  if [[ "$pods_present" -eq 1 ]]; then
    echo "[doctor:ios] CocoaPods directory exists"
  else
    echo "[doctor:ios] CocoaPods directory is not present yet"
  fi
fi
