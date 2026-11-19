import type { ProxyNode, ProxyProtocol } from "../core/model/proxy-node.ts";
import type {
  NodeTestController,
  NodeTestResponse,
  UnlockServiceDefinition,
} from "../node-test.ts";
import type { Diagnostic } from "../core/diagnostics/index.ts";

export type SourceState = "pending" | "success" | "error";
export type ProcessingState = "idle" | "running" | "done" | "warning" | "error";
export type SourceKind = "local" | "remote";

export interface CategorizedOutput {
  id: string;
  name: string;
  originalName: string;
  server: string;
  port: number;
  protocol: ProxyProtocol;
  uri: string;
  countryCode: string | null;
  node: ProxyNode;
}

export interface OutputFilter {
  protocolsEnabled: boolean;
  protocols: ProxyProtocol[];
  countriesEnabled: boolean;
  countries: string[];
}

export interface BatchRenameSettings {
  region: boolean;
  entry: boolean;
  exit: boolean;
  tcping: boolean;
  url204: boolean;
  averageSpeed: boolean;
  peakSpeed: boolean;
  unlockSummary: boolean;
  keepOriginalName: boolean;
}

export interface CleaningSettings {
  tcpingFailureThresholdMs: number;
  url204FailureThresholdMs: number;
  bandwidthFailureThresholdMbps: number;
}

export interface OutputTableColumn {
  key: string;
  label: string;
  settingsLabel?: string;
  width: number;
  className?: string;
  renderCell: (entry: CategorizedOutput, index: number) => HTMLTableCellElement;
  renderFooter?: (entries: CategorizedOutput[]) => HTMLTableCellElement;
}

export interface SourceResult {
  sourceId: string;
  kind: SourceKind;
  url: string;
  state: SourceState;
  nodes: string[];
  content?: string;
  diagnostics: Diagnostic[];
  bytes?: number;
  finalUrl?: string;
  usedUserAgent?: string;
  errorCode?: string;
  errorMessage?: string;
}

export type FetchConcurrencyMode = "fixed" | "percent";

export interface FetchConcurrencySetting {
  mode: FetchConcurrencyMode;
  value: number;
}

export interface NodeTestOutputEntry {
  id: string;
  name: string;
  server: string;
  port: number;
  protocol: ProxyProtocol;
  node: ProxyNode;
}

export type AppNodeTestController = NodeTestController;
export type { NodeTestResponse, UnlockServiceDefinition };
