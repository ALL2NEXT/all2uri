import type { Diagnostic } from "./diagnostics/index.ts";
import type { ConversionStatus } from "./encoders/uri-encoder.ts";
import type { ProxyNode, ProxyProtocol } from "./model/proxy-node.ts";

export interface LossyConversionLogEntry {
  id: string;
  name: string;
  server: string;
  port: number;
  protocol: ProxyProtocol;
  uri: string | null;
  conversionStatus: ConversionStatus;
  conversionDiagnostics: Diagnostic[];
  node: ProxyNode;
}

export interface LossyConversionLogOptions {
  scope: "all" | "filtered";
  generatedAt?: string;
}

type SafeJsonValue =
  | string
  | number
  | boolean
  | null
  | SafeJsonValue[]
  | { [key: string]: SafeJsonValue };

function toJsonValue(
  value: unknown,
  seen: WeakSet<object>,
): SafeJsonValue {
  if (value === null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "undefined") return "[undefined]";
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    const safe = value.map((item) => toJsonValue(item, seen));
    seen.delete(value);
    return safe;
  }
  const safe = Object.fromEntries(
    Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      toJsonValue(childValue, seen),
    ]),
  );
  seen.delete(value);
  return safe;
}

function toJsonRecord(value: Record<string, unknown>): {
  [key: string]: SafeJsonValue;
} {
  const safe = toJsonValue(value, new WeakSet<object>());
  return typeof safe === "object" && safe !== null && !Array.isArray(safe)
    ? safe
    : {};
}

export function buildLossyConversionLog(
  entries: LossyConversionLogEntry[],
  options: LossyConversionLogOptions,
) {
  const lossyEntries = entries.filter(
    (entry) => entry.conversionStatus === "lossy",
  );
  const nodes = lossyEntries.map((entry) => {
    const diagnostics = entry.conversionDiagnostics.filter(
      (item) => item.code === "field_not_encoded",
    );
    const unencodedFields = [
      ...new Set(diagnostics.map((item) => item.field).filter((field): field is string => !!field)),
    ].sort();
    return {
      id: entry.id,
      name: entry.name,
      protocol: entry.protocol,
      server: entry.server,
      port: entry.port,
      outputUri: entry.uri,
      sources: entry.node.sources.map((source) => ({
        sourceId: source.sourceId,
        format: source.format,
        ...(source.location ? { location: source.location } : {}),
      })),
      unencodedFields,
      diagnostics: diagnostics.map((item) => ({
        sourceId: item.sourceId,
        stage: item.stage,
        code: item.code,
        severity: item.severity,
        message: item.message,
        ...(item.location ? { location: item.location } : {}),
        ...(item.field ? { field: item.field } : {}),
        ...(item.compatibility ? { compatibility: item.compatibility } : {}),
      })),
      settings: toJsonRecord(entry.node.settings),
      extensions: toJsonRecord(entry.node.extensions),
    };
  });
  const unencodedFields = [
    ...new Set(nodes.flatMap((node) => node.unencodedFields)),
  ].sort();

  return {
    schemaVersion: 2,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    scope: options.scope,
    summary: {
      lossyNodeCount: nodes.length,
      distinctUnencodedFieldCount: unencodedFields.length,
      unencodedFields,
    },
    nodes,
  };
}
