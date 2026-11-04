import type {
  ClientPerformanceReport,
  ClientPerformanceReportResult,
  PerformanceSnapshot,
} from '../performance/types.js';
export type GatewayPerformanceGetParams = Record<string, never>;
export type GatewayPerformanceGetResult = PerformanceSnapshot;
export type GatewayPerformanceReportParams = ClientPerformanceReport;
export type GatewayPerformanceReportResult = ClientPerformanceReportResult;
