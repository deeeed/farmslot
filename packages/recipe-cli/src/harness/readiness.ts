// What `doctor` and `status` take from the host beyond the platform adapters:
// the checkout view, how feature-flag records read, and the device preview.

import type { AdapterPinnedFlags, AdapterReadiness, PlatformAdapter } from '@farmslot/adapter-sdk';

import type { CliOptions } from './parse-args.js';

/** A host's report of a feature-flag override record, for doctor and status. */
export interface FeatureFlagReport {
  // The one human line, starting `feature flags: `.
  summary: string;
  // null: no runtime answered (never rendered as zero overrides).
  overrideCount: number | null;
  error?: string;
}

/** The device-targeting preview doctor and status run (it never gates). */
export type DevicePreview = (
  command: 'doctor' | 'status',
  adapter: string,
  options: CliOptions,
) => { ok: true } | { ok: false; code: string; message: string; userAction: string };

export interface ReadinessViewOptions {
  // What the checkout is bound to (ports, libraries, fixture): `view` in the
  // JSON envelope and a block in the human output.
  checkoutView?(target: string, adapter: string): { json: unknown; text: string };
  // How an override record reads. Absent: no feature-flag line or field.
  featureFlags?: {
    report(
      overrides: unknown,
      detail?: Pick<AdapterPinnedFlags, 'error' | 'sourcePath'>,
    ): FeatureFlagReport;
  };
  // Device targeting, previewed: the same target run/call would use.
  previewDevice?: DevicePreview;
}

export function adapterReadiness(adapter: PlatformAdapter): AdapterReadiness {
  return adapter.readiness ?? {};
}

export type Paint = (style: string, text: string) => string;

// One line, one shape: an active override is highlighted so a slot never runs a
// proof under an unnamed variant without saying so.
export function renderFeatureFlagLine(report: FeatureFlagReport, out: Paint): void {
  const style = report.error ? 'warn' : (report.overrideCount ?? 0) > 0 ? 'warn' : 'dim';
  console.log(
    `${out('label', 'feature flags:')} ${out(style, report.summary.replace(/^feature flags: /u, ''))}`,
  );
}
