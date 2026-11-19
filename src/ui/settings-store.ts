import type { ProxyProtocol } from "../core/model/proxy-node.ts";
import {
  DEFAULT_REGION_LOOKUP_METHODS,
  normalizeRegionCode,
  REGION_LOOKUP_OPTIONS,
} from "../core/location/region.ts";
import type { RegionLookupMethod } from "../core/location/region.ts";
import { OUTPUT_COLUMN_MIN_WIDTH, OUTPUT_PROTOCOLS } from "./output-options.ts";
import type {
  BatchRenameSettings,
  CleaningSettings,
  OutputFilter,
} from "./types.ts";

const OUTPUT_FILTER_STORAGE_KEY = "all2uri.output-filter";
const OUTPUT_COLUMN_WIDTHS_STORAGE_KEY =
  "all2uri.output-table-column-widths.v2";
const OUTPUT_COLUMN_VISIBILITY_STORAGE_KEY =
  "all2uri.output-table-column-visibility.v1";
const ENTRY_REGION_METHODS_STORAGE_KEY = "all2uri.entry-region-methods";
const EXIT_REGION_METHODS_STORAGE_KEY = "all2uri.exit-region-methods";
const ENTRY_REGION_CONCURRENCY_STORAGE_KEY = "all2uri.entry-region-concurrency";
const EXIT_REGION_CONCURRENCY_STORAGE_KEY = "all2uri.exit-region-concurrency";
const ENTRY_GEOIP_DATABASE_PATH_STORAGE_KEY =
  "all2uri.entry-geoip-database-path";
const EXIT_GEOIP_DATABASE_PATH_STORAGE_KEY = "all2uri.exit-geoip-database-path";
const LEGACY_REGION_LOOKUP_METHODS_STORAGE_KEY =
  "all2uri.region-lookup-methods";
const LEGACY_REGION_LOOKUP_CONCURRENCY_STORAGE_KEY =
  "all2uri.region-lookup-concurrency";
const LEGACY_GEOIP_DATABASE_PATH_STORAGE_KEY = "all2uri.geoip-database-path";
const LEGACY_DETECTED_IP_REGION_METHODS_STORAGE_KEY =
  "all2uri.detected-ip-region-methods";
const LEGACY_DETECTED_IP_REGION_CONCURRENCY_STORAGE_KEY =
  "all2uri.detected-ip-region-concurrency";
const LEGACY_DETECTED_IP_GEOIP_DATABASE_PATH_STORAGE_KEY =
  "all2uri.detected-ip-geoip-database-path";
const BATCH_RENAME_SETTINGS_STORAGE_KEY = "all2uri.batch-rename-settings";
const CLEANING_SETTINGS_STORAGE_KEY = "all2uri.cleaning-settings";
const LEGACY_NODE_TEST_SETTINGS_STORAGE_KEY = "all2uri.node-test-settings";

export const MIN_REGION_LOOKUP_CONCURRENCY = 1;
const DEFAULT_REGION_LOOKUP_CONCURRENCY = 8;
const DEFAULT_EXIT_REGION_METHODS: RegionLookupMethod[] = [
  "LOCAL_GEOIP",
  "REMOTE_API",
];
export const DEFAULT_CLEANING_SETTINGS: CleaningSettings = {
  tcpingFailureThresholdMs: 1_000,
  url204FailureThresholdMs: 1_000,
  bandwidthFailureThresholdMbps: 1,
};

const DEFAULT_BATCH_RENAME_SETTINGS: BatchRenameSettings = {
  region: true,
  entry: true,
  exit: true,
  tcping: true,
  url204: true,
  averageSpeed: true,
  peakSpeed: false,
  unlockSummary: false,
  keepOriginalName: true,
};

export interface RegionSettings {
  entryMethods: RegionLookupMethod[];
  exitMethods: RegionLookupMethod[];
  entryConcurrency: number;
  exitConcurrency: number;
  entryGeoIpDatabasePath: string;
  exitGeoIpDatabasePath: string;
}

function isProxyProtocol(value: unknown): value is ProxyProtocol {
  return (
    typeof value === "string" &&
    OUTPUT_PROTOCOLS.some((item) => item.value === value)
  );
}

function isRegionLookupMethod(value: unknown): value is RegionLookupMethod {
  return (
    typeof value === "string" &&
    REGION_LOOKUP_OPTIONS.some((item) => item.value === value)
  );
}

function loadRegionMethodsFromStorage(
  storageKey: string,
  availableMethods: RegionLookupMethod[],
  fallback: RegionLookupMethod[],
): RegionLookupMethod[] | null {
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (stored === null) return null;
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed)
      ? [
          ...new Set(
            parsed
              .filter(isRegionLookupMethod)
              .filter((method) => availableMethods.includes(method)),
          ),
        ]
      : [...fallback];
  } catch {
    return [...fallback];
  }
}

function loadLegacyRegionLookupMethods(): RegionLookupMethod[] {
  return (
    loadRegionMethodsFromStorage(
      LEGACY_REGION_LOOKUP_METHODS_STORAGE_KEY,
      REGION_LOOKUP_OPTIONS.map((option) => option.value),
      [...DEFAULT_REGION_LOOKUP_METHODS],
    ) ?? [...DEFAULT_REGION_LOOKUP_METHODS]
  );
}

function loadLegacyDetectedIpRegionMethods(): RegionLookupMethod[] {
  return (
    loadRegionMethodsFromStorage(
      LEGACY_DETECTED_IP_REGION_METHODS_STORAGE_KEY,
      DEFAULT_EXIT_REGION_METHODS,
      loadLegacyRegionLookupMethods().filter(
        (method) => method !== "NODE_NAME",
      ),
    ) ??
    loadLegacyRegionLookupMethods().filter((method) => method !== "NODE_NAME")
  );
}

function loadEntryRegionMethods(): RegionLookupMethod[] {
  const stored = loadRegionMethodsFromStorage(
    ENTRY_REGION_METHODS_STORAGE_KEY,
    REGION_LOOKUP_OPTIONS.map((option) => option.value),
    [...DEFAULT_REGION_LOOKUP_METHODS],
  );
  if (stored !== null) return stored;
  const legacyNodeMethods = loadLegacyRegionLookupMethods();
  const legacyIpMethods = loadLegacyDetectedIpRegionMethods();
  const migrated = [
    ...(legacyNodeMethods.includes("NODE_NAME") ? ["NODE_NAME" as const] : []),
    ...legacyIpMethods,
  ];
  return [
    ...new Set(migrated.length ? migrated : DEFAULT_REGION_LOOKUP_METHODS),
  ];
}

function loadExitRegionMethods(): RegionLookupMethod[] {
  return (
    loadRegionMethodsFromStorage(
      EXIT_REGION_METHODS_STORAGE_KEY,
      DEFAULT_EXIT_REGION_METHODS,
      [...DEFAULT_EXIT_REGION_METHODS],
    ) ?? loadLegacyDetectedIpRegionMethods()
  );
}

function storedRegionConcurrency(storageKey: string): number | null {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isInteger(value) && value >= MIN_REGION_LOOKUP_CONCURRENCY
      ? value
      : DEFAULT_REGION_LOOKUP_CONCURRENCY;
  } catch {
    return DEFAULT_REGION_LOOKUP_CONCURRENCY;
  }
}

function loadEntryRegionConcurrency(): number {
  return (
    storedRegionConcurrency(ENTRY_REGION_CONCURRENCY_STORAGE_KEY) ??
    storedRegionConcurrency(
      LEGACY_DETECTED_IP_REGION_CONCURRENCY_STORAGE_KEY,
    ) ??
    storedRegionConcurrency(LEGACY_REGION_LOOKUP_CONCURRENCY_STORAGE_KEY) ??
    DEFAULT_REGION_LOOKUP_CONCURRENCY
  );
}

function loadExitRegionConcurrency(): number {
  return (
    storedRegionConcurrency(EXIT_REGION_CONCURRENCY_STORAGE_KEY) ??
    storedRegionConcurrency(
      LEGACY_DETECTED_IP_REGION_CONCURRENCY_STORAGE_KEY,
    ) ??
    DEFAULT_REGION_LOOKUP_CONCURRENCY
  );
}

function loadEntryGeoIpDatabasePath(): string {
  try {
    const stored = window.localStorage.getItem(
      ENTRY_GEOIP_DATABASE_PATH_STORAGE_KEY,
    );
    if (stored !== null) return stored;
    const nodePath = window.localStorage.getItem(
      LEGACY_GEOIP_DATABASE_PATH_STORAGE_KEY,
    );
    const detectedPath = window.localStorage.getItem(
      LEGACY_DETECTED_IP_GEOIP_DATABASE_PATH_STORAGE_KEY,
    );
    return nodePath ?? detectedPath ?? "";
  } catch {
    return "";
  }
}

function loadExitGeoIpDatabasePath(): string {
  try {
    const stored = window.localStorage.getItem(
      EXIT_GEOIP_DATABASE_PATH_STORAGE_KEY,
    );
    if (stored !== null) return stored;
    const detectedPath = window.localStorage.getItem(
      LEGACY_DETECTED_IP_GEOIP_DATABASE_PATH_STORAGE_KEY,
    );
    const nodePath = window.localStorage.getItem(
      LEGACY_GEOIP_DATABASE_PATH_STORAGE_KEY,
    );
    return detectedPath ?? nodePath ?? "";
  } catch {
    return "";
  }
}

export function loadRegionSettings(): RegionSettings {
  return {
    entryMethods: loadEntryRegionMethods(),
    exitMethods: loadExitRegionMethods(),
    entryConcurrency: loadEntryRegionConcurrency(),
    exitConcurrency: loadExitRegionConcurrency(),
    entryGeoIpDatabasePath: loadEntryGeoIpDatabasePath(),
    exitGeoIpDatabasePath: loadExitGeoIpDatabasePath(),
  };
}

export function loadBatchRenameSettings(): BatchRenameSettings {
  const fallback = DEFAULT_BATCH_RENAME_SETTINGS;
  try {
    const stored = window.localStorage.getItem(
      BATCH_RENAME_SETTINGS_STORAGE_KEY,
    );
    if (stored === null) return { ...fallback };
    const parsed: unknown = JSON.parse(stored);
    if (typeof parsed !== "object" || parsed === null) return { ...fallback };
    const candidate = parsed as Partial<BatchRenameSettings> & {
      linkType?: unknown;
    };
    const legacyLinkType =
      typeof candidate.linkType === "boolean"
        ? candidate.linkType
        : fallback.entry;
    return {
      region:
        typeof candidate.region === "boolean"
          ? candidate.region
          : fallback.region,
      entry:
        typeof candidate.entry === "boolean" ? candidate.entry : legacyLinkType,
      exit:
        typeof candidate.exit === "boolean" ? candidate.exit : legacyLinkType,
      tcping:
        typeof candidate.tcping === "boolean"
          ? candidate.tcping
          : fallback.tcping,
      url204:
        typeof candidate.url204 === "boolean"
          ? candidate.url204
          : fallback.url204,
      averageSpeed:
        typeof candidate.averageSpeed === "boolean"
          ? candidate.averageSpeed
          : fallback.averageSpeed,
      peakSpeed:
        typeof candidate.peakSpeed === "boolean"
          ? candidate.peakSpeed
          : fallback.peakSpeed,
      unlockSummary:
        typeof candidate.unlockSummary === "boolean"
          ? candidate.unlockSummary
          : fallback.unlockSummary,
      keepOriginalName:
        typeof candidate.keepOriginalName === "boolean"
          ? candidate.keepOriginalName
          : fallback.keepOriginalName,
    };
  } catch {
    return { ...fallback };
  }
}

export function saveBatchRenameSettings(settings: BatchRenameSettings) {
  try {
    window.localStorage.setItem(
      BATCH_RENAME_SETTINGS_STORAGE_KEY,
      JSON.stringify(settings),
    );
  } catch {
    // 当前会话仍可使用重命名设置。
  }
}

export function normalizeCleaningThreshold(
  value: unknown,
  fallback: number,
  maximum: number,
): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(1, Math.round(parsed)));
}

export function loadCleaningSettings(): CleaningSettings {
  try {
    const stored = window.localStorage.getItem(CLEANING_SETTINGS_STORAGE_KEY);
    if (stored !== null) {
      const parsed: unknown = JSON.parse(stored);
      if (typeof parsed === "object" && parsed !== null) {
        const candidate = parsed as Partial<CleaningSettings>;
        return {
          tcpingFailureThresholdMs: normalizeCleaningThreshold(
            candidate.tcpingFailureThresholdMs,
            DEFAULT_CLEANING_SETTINGS.tcpingFailureThresholdMs,
            120_000,
          ),
          url204FailureThresholdMs: normalizeCleaningThreshold(
            candidate.url204FailureThresholdMs,
            DEFAULT_CLEANING_SETTINGS.url204FailureThresholdMs,
            120_000,
          ),
          bandwidthFailureThresholdMbps: normalizeCleaningThreshold(
            candidate.bandwidthFailureThresholdMbps,
            DEFAULT_CLEANING_SETTINGS.bandwidthFailureThresholdMbps,
            10_000,
          ),
        };
      }
    }

    const legacy = window.localStorage.getItem(
      LEGACY_NODE_TEST_SETTINGS_STORAGE_KEY,
    );
    if (legacy !== null) {
      const parsed: unknown = JSON.parse(legacy);
      if (typeof parsed === "object" && parsed !== null) {
        const legacyThreshold = (parsed as Record<string, unknown>)
          .bandwidthAutoDeleteThresholdMbps;
        if (legacyThreshold !== undefined) {
          return {
            ...DEFAULT_CLEANING_SETTINGS,
            bandwidthFailureThresholdMbps: normalizeCleaningThreshold(
              legacyThreshold,
              DEFAULT_CLEANING_SETTINGS.bandwidthFailureThresholdMbps,
              10_000,
            ),
          };
        }
      }
    }
  } catch {
    // 使用默认清洗阈值继续运行。
  }
  return { ...DEFAULT_CLEANING_SETTINGS };
}

export function saveCleaningSettings(settings: CleaningSettings) {
  try {
    window.localStorage.setItem(
      CLEANING_SETTINGS_STORAGE_KEY,
      JSON.stringify(settings),
    );
  } catch {
    // 当前会话仍可使用清洗设置。
  }
}

export function loadOutputFilter(): OutputFilter {
  const empty = (): OutputFilter => ({
    protocolsEnabled: false,
    protocols: [],
    countriesEnabled: false,
    countries: [],
  });
  try {
    const stored = window.localStorage.getItem(OUTPUT_FILTER_STORAGE_KEY);
    if (stored === null) return empty();
    const parsed: unknown = JSON.parse(stored);
    if (typeof parsed !== "object" || parsed === null) return empty();
    const candidate = parsed as Partial<OutputFilter>;
    const protocols = Array.isArray(candidate.protocols)
      ? [...new Set(candidate.protocols.filter(isProxyProtocol))]
      : [];
    const countries = Array.isArray(candidate.countries)
      ? [
          ...new Set(
            candidate.countries
              .map(normalizeRegionCode)
              .filter((code): code is string => code !== null),
          ),
        ]
      : [];
    return {
      protocolsEnabled:
        typeof candidate.protocolsEnabled === "boolean"
          ? candidate.protocolsEnabled
          : protocols.length > 0,
      protocols,
      countriesEnabled:
        typeof candidate.countriesEnabled === "boolean"
          ? candidate.countriesEnabled
          : countries.length > 0,
      countries,
    };
  } catch {
    return empty();
  }
}

export function saveOutputFilter(filter: OutputFilter) {
  try {
    window.localStorage.setItem(
      OUTPUT_FILTER_STORAGE_KEY,
      JSON.stringify(filter),
    );
  } catch {
    // 筛选条件仍可在当前会话中使用；存储不可用时忽略持久化错误。
  }
}

export function loadOutputColumnWidths(): Record<string, number> {
  try {
    const storedWidths = window.localStorage.getItem(
      OUTPUT_COLUMN_WIDTHS_STORAGE_KEY,
    );
    if (storedWidths !== null) {
      const parsed: unknown = JSON.parse(storedWidths);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed)
      ) {
        return Object.fromEntries(
          Object.entries(parsed)
            .filter(
              (entry): entry is [string, number] =>
                typeof entry[1] === "number" &&
                Number.isFinite(entry[1]) &&
                entry[1] > 0,
            )
            .map(([key, width]) => [
              key,
              Math.max(OUTPUT_COLUMN_MIN_WIDTH, width),
            ]),
        );
      }
    }
  } catch {
    return {};
  }
  return {};
}

export function saveOutputColumnWidths(widths: Record<string, number>) {
  try {
    window.localStorage.setItem(
      OUTPUT_COLUMN_WIDTHS_STORAGE_KEY,
      JSON.stringify(widths),
    );
  } catch {
    // 列宽仍可在当前会话中调整；存储不可用时忽略持久化错误。
  }
}

export function loadOutputColumnVisibility(): Record<string, boolean> {
  try {
    const storedVisibility = window.localStorage.getItem(
      OUTPUT_COLUMN_VISIBILITY_STORAGE_KEY,
    );
    if (storedVisibility !== null) {
      const parsed: unknown = JSON.parse(storedVisibility);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed)
      ) {
        return Object.fromEntries(
          Object.entries(parsed).filter(
            (entry): entry is [string, boolean] =>
              typeof entry[1] === "boolean",
          ),
        );
      }
    }
  } catch {
    return {};
  }
  return {};
}

export function saveOutputColumnVisibility(
  visibility: Record<string, boolean>,
) {
  try {
    window.localStorage.setItem(
      OUTPUT_COLUMN_VISIBILITY_STORAGE_KEY,
      JSON.stringify(visibility),
    );
  } catch {
    // 列显示设置仍可在当前会话中使用；存储不可用时忽略持久化错误。
  }
}

export function saveEntryRegionMethods(methods: RegionLookupMethod[]) {
  try {
    window.localStorage.setItem(
      ENTRY_REGION_METHODS_STORAGE_KEY,
      JSON.stringify(methods),
    );
  } catch {
    // 查询规则仍可在当前会话中使用；存储不可用时忽略持久化错误。
  }
}

export function saveExitRegionMethods(methods: RegionLookupMethod[]) {
  try {
    window.localStorage.setItem(
      EXIT_REGION_METHODS_STORAGE_KEY,
      JSON.stringify(methods),
    );
  } catch {
    // 查询规则仍可在当前会话中使用；存储不可用时忽略持久化错误。
  }
}

export function saveEntryRegionConcurrency(concurrency: number) {
  try {
    window.localStorage.setItem(
      ENTRY_REGION_CONCURRENCY_STORAGE_KEY,
      String(concurrency),
    );
  } catch {
    return;
  }
}

export function saveExitRegionConcurrency(concurrency: number) {
  try {
    window.localStorage.setItem(
      EXIT_REGION_CONCURRENCY_STORAGE_KEY,
      String(concurrency),
    );
  } catch {
    return;
  }
}

export function saveEntryGeoIpDatabasePath(path: string) {
  try {
    window.localStorage.setItem(ENTRY_GEOIP_DATABASE_PATH_STORAGE_KEY, path);
  } catch {
    // 入口数据库仍可在当前会话中使用；存储不可用时忽略持久化错误。
  }
}

export function saveExitGeoIpDatabasePath(path: string) {
  try {
    window.localStorage.setItem(EXIT_GEOIP_DATABASE_PATH_STORAGE_KEY, path);
  } catch {
    // 出口数据库仍可在当前会话中使用；存储不可用时忽略持久化错误。
  }
}

export function migrateRegionSettings(settings: RegionSettings) {
  try {
    const entries: Array<[string, string]> = [
      [ENTRY_REGION_METHODS_STORAGE_KEY, JSON.stringify(settings.entryMethods)],
      [EXIT_REGION_METHODS_STORAGE_KEY, JSON.stringify(settings.exitMethods)],
      [ENTRY_REGION_CONCURRENCY_STORAGE_KEY, String(settings.entryConcurrency)],
      [EXIT_REGION_CONCURRENCY_STORAGE_KEY, String(settings.exitConcurrency)],
      [ENTRY_GEOIP_DATABASE_PATH_STORAGE_KEY, settings.entryGeoIpDatabasePath],
      [EXIT_GEOIP_DATABASE_PATH_STORAGE_KEY, settings.exitGeoIpDatabasePath],
    ];
    for (const [key, value] of entries) {
      if (window.localStorage.getItem(key) === null)
        window.localStorage.setItem(key, value);
    }
  } catch {
    // 存储不可用时继续使用启动时读取到的兼容设置。
  }
}
