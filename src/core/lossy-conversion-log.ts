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

const SENSITIVE_KEY = /^(?:.*(?:password|passwd|pwd|uuid|token|secret|privatekey|credential|username|apikey|accesskey|cookie).*|auth(?:|str|token|key|password|orization|entication)|user|userpass|login)$/i;
const OMITTED_KEY = /^(?:raw.*|.*uri)$/i;
const URI_VALUE = /[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;

function sanitizeString(value: string): string {
  return value.replace(URI_VALUE, "[URI omitted]");
}

function toJsonValue(
  value: unknown,
  seen: WeakSet<object>,
  key?: string,
): SafeJsonValue {
  const normalizedKey = key?.toLowerCase().replace(/[-_]/g, "");
  if (normalizedKey && SENSITIVE_KEY.test(normalizedKey)) return "[REDACTED]";
  if (normalizedKey && OMITTED_KEY.test(normalizedKey)) return "[OMITTED]";
  if (value === null) return null;
  if (typeof value === "string") return sanitizeString(value);
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
      toJsonValue(childValue, seen, childKey),
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
      id: sanitizeString(entry.id),
      name: sanitizeString(entry.name),
      protocol: entry.protocol,
      server: sanitizeString(entry.server),
      port: entry.port,
      sources: entry.node.sources.map((source) => ({
        sourceId: sanitizeString(source.sourceId),
        format: sanitizeString(source.format),
        ...(source.location ? { location: sanitizeString(source.location) } : {}),
      })),
      unencodedFields,
      diagnostics: diagnostics.map((item) => ({
        sourceId: sanitizeString(item.sourceId),
        stage: sanitizeString(item.stage),
        code: sanitizeString(item.code),
        severity: item.severity,
        message: sanitizeString(item.message),
        ...(item.location ? { location: sanitizeString(item.location) } : {}),
        ...(item.field ? { field: sanitizeString(item.field) } : {}),
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
    schemaVersion: 3,
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
