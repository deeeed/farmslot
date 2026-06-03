#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"

source "${SCRIPT_DIR}/agentic.conf"

expo_package="$(
  cd "${APP_DIR}"
  env \
    APP_VARIANT="${APP_VARIANT}" \
    SITEED_BUNDLE_BASE="${SITEED_BUNDLE_BASE}" \
    SITEED_SCHEME_BASE="${SITEED_SCHEME_BASE}" \
    BUNDLE_ID="${BUNDLE_ID}" \
    SCHEME="${SCHEME}" \
    yarn expo config --type public --json 2>/dev/null | node -e "
      const chunks = [];
      process.stdin.on('data', (chunk) => chunks.push(chunk));
      process.stdin.on('end', () => {
        const config = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        process.stdout.write(config.android?.package || '');
      });
    "
)"

if [[ "${expo_package}" != "${BUNDLE_ID}" ]]; then
  echo "ERROR: local Android launch identity drifted." >&2
  echo "  agentic.conf BUNDLE_ID=${BUNDLE_ID}" >&2
  echo "  expo android.package=${expo_package}" >&2
  exit 1
fi

printf 'ok - Android local launch identity matches Expo config (%s)\n' "${BUNDLE_ID}"

# Unit-test the generated Android identity guard without launching Expo or Gradle.
# run-android.sh is sourceable so clean-checkout behavior stays tested here.
# shellcheck source=./run-android.sh
source "${SCRIPT_DIR}/run-android.sh"

temp_android_project=""
with_temp_android_project() {
  local package_id="$1"
  temp_android_project="$(mktemp -d)"
  APP_DIR="${temp_android_project}"
  BUNDLE_ID="net.siteed.farmslot.development"
  APP_VARIANT="development"
  unset ANDROID_REPAIR_NATIVE
  if [[ -n "${package_id}" ]]; then
    mkdir -p "${APP_DIR}/android/app"
    cat >"${APP_DIR}/android/app/build.gradle" <<GRADLE
android {
    defaultConfig {
        applicationId "${package_id}"
    }
}
GRADLE
  fi
}

with_temp_android_project ""
if ! ensure_android_native_identity >/tmp/farmslot-android-clean.out 2>/tmp/farmslot-android-clean.err; then
  echo "ERROR: missing generated android/ should be allowed so Expo can prebuild it." >&2
  cat /tmp/farmslot-android-clean.err >&2
  rm -rf "${temp_android_project}"
  exit 1
fi
rm -rf "${temp_android_project}"

with_temp_android_project "net.siteed.farmslot.development"
if ! ensure_android_native_identity >/tmp/farmslot-android-match.out 2>/tmp/farmslot-android-match.err; then
  echo "ERROR: matching generated Android applicationId should pass." >&2
  cat /tmp/farmslot-android-match.err >&2
  rm -rf "${temp_android_project}"
  exit 1
fi
rm -rf "${temp_android_project}"

with_temp_android_project "net.siteed.farmslot"
if ensure_android_native_identity </dev/null >/tmp/farmslot-android-stale.out 2>/tmp/farmslot-android-stale.err; then
  echo "ERROR: stale generated Android applicationId should fail in non-interactive mode." >&2
  rm -rf "${temp_android_project}"
  exit 1
fi
if ! grep -q 'Android native identity does not match' /tmp/farmslot-android-stale.err; then
  echo "ERROR: stale generated Android failure did not explain the identity mismatch." >&2
  cat /tmp/farmslot-android-stale.err >&2
  rm -rf "${temp_android_project}"
  exit 1
fi
rm -rf "${temp_android_project}"

printf 'ok - Android native identity guard allows clean checkout and rejects stale generated app id\n'
