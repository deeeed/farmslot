/**
 * The `target` a re-targeted recipe rerun sends (ADR-054 item 3).
 *
 * There is no device inventory to pick from, so the operator types the identity
 * — which is exactly why it is validated here against the protocol's identity
 * charset before it reaches a Gateway that substitutes it into a project hook
 * command. An empty value means "use the slot's configured device".
 *
 * Kept out of the Lit element so it is testable without a DOM.
 */
import {
  isRuntimeCapabilityTargetKey,
  isRuntimeCapabilityTargetValue,
  RUNTIME_CAPABILITY_TARGET_VALUE_PATTERN,
  type RuntimeCapabilityTarget,
} from '@farmslot/protocol';

export function recipeRerunTarget(
  key: string,
  value: string,
): { target?: RuntimeCapabilityTarget; error?: string } {
  const identity = value.trim();
  if (!identity) return {};
  if (!isRuntimeCapabilityTargetKey(key)) {
    return { error: `'${key}' is not a device identity parameter` };
  }
  if (!isRuntimeCapabilityTargetValue(identity)) {
    return {
      error: `Device identity must match ${RUNTIME_CAPABILITY_TARGET_VALUE_PATTERN.source}`,
    };
  }
  return { target: { [key]: identity } };
}
