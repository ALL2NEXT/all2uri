import { semanticFingerprint } from "../core/deduplication/index.ts";
import { encodeProxyNode } from "../core/encoders/uri-encoder.ts";
import type { ProxyNode } from "../core/model/proxy-node.ts";
import type {
  BatchRenameSettings,
  CategorizedOutput,
  CleaningSettings,
} from "./types.ts";
import type { DomElements } from "./dom.ts";
import type { NodeTestController, NodeTestKind } from "../node-test.ts";
import {
  countryNameForCode,
  UNKNOWN_REGION_CODE,
} from "../core/location/region.ts";

interface OutputMaintenanceDependencies {
  dom: DomElements;
  getBatchRenameSettings: () => BatchRenameSettings;
  getCleaningSettings: () => CleaningSettings;
  getOutputEntries: () => CategorizedOutput[];
  setOutputEntries: (entries: CategorizedOutput[]) => void;
  getFilteredOutputEntries: () => CategorizedOutput[];
  getNodeTestController: () => NodeTestController | null;
  isRunning: () => boolean;
  isRegionLookupRunning: () => boolean;
  renderOutputFilter: () => void;
  showToast: (message: string, isError?: boolean) => void;
  cdnRenameLabel: (
    provider: string | undefined,
    kind: "entry" | "exit",
  ) => string;
  formatSpeed: (mbps: number) => string;
}

export function createOutputMaintenance({
  dom,
  getBatchRenameSettings,
  getCleaningSettings,
  getOutputEntries,
  setOutputEntries,
  getFilteredOutputEntries,
  getNodeTestController,
  isRunning,
  isRegionLookupRunning,
  renderOutputFilter,
  showToast,
  cdnRenameLabel,
  formatSpeed,
}: OutputMaintenanceDependencies) {
  function buildBatchRenameName(entry: CategorizedOutput): string | null {
    const parts: string[] = [];
    const settings = getBatchRenameSettings();

    if (
      settings.region &&
      entry.countryCode &&
      entry.countryCode !== UNKNOWN_REGION_CODE
    ) {
      parts.push(countryNameForCode(entry.countryCode));
    }

    if (settings.entry) {
      const state = getNodeTestController()?.getResult(entry.id, "entry");
      if (state?.state === "running")
        parts.push("\u5165\u53e3\u68c0\u6d4b\u4e2d");
      else if (state?.state === "error" || state?.result?.success === false)
        parts.push("\u5165\u53e3\u5931\u8d25");
      else if (state?.result?.success)
        parts.push(cdnRenameLabel(state.result.cdnProvider, "entry"));
    }

    if (settings.exit) {
      const state = getNodeTestController()?.getResult(entry.id, "exit");
      if (state?.state === "running")
        parts.push("\u51fa\u53e3\u68c0\u6d4b\u4e2d");
      else if (state?.state === "error" || state?.result?.success === false)
        parts.push("\u51fa\u53e3\u5931\u8d25");
      else if (state?.result?.success)
        parts.push(cdnRenameLabel(state.result.cdnProvider, "exit"));
    }

    if (settings.tcping) {
      const state = getNodeTestController()?.getResult(entry.id, "tcping");
      if (state?.state === "running") parts.push("TCP检测中");
      else if (state?.state === "error" || state?.result?.success === false)
        parts.push("TCP失败");
      else if (state?.result?.latencyMs !== undefined)
        parts.push(`TCP ${state.result.latencyMs}ms`);
    }

    if (settings.url204) {
      const state = getNodeTestController()?.getResult(entry.id, "url204");
      if (state?.state === "running") parts.push("204检测中");
      else if (state?.state === "error" || state?.result?.success === false)
        parts.push("204失败");
      else if (state?.result?.latencyMs !== undefined)
        parts.push(`204 ${state.result.latencyMs}ms`);
    }

    if (settings.averageSpeed || settings.peakSpeed) {
      const state = getNodeTestController()?.getResult(entry.id, "bandwidth");
      if (state?.state === "running") parts.push("测速中");
      else if (state?.state === "error" || state?.result?.success === false)
        parts.push("测速失败");
      else if (state?.result) {
        if (settings.averageSpeed && state.result.downloadMbps !== undefined) {
          parts.push(`均 ${formatSpeed(state.result.downloadMbps)}`);
        }
        if (settings.peakSpeed) {
          const peak =
            state.result.downloadMaxMbps ?? state.result.downloadMbps;
          if (peak !== undefined) parts.push(`峰 ${formatSpeed(peak)}`);
        }
      }
    }

    if (settings.unlockSummary) {
      const state = getNodeTestController()?.getResult(entry.id, "unlock");
      if (state?.state === "running") parts.push("解锁检测中");
      else if (state?.state === "error" || state?.result?.success === false)
        parts.push("解锁失败");
      else if (state?.result?.unlock) {
        const services = state.result.unlock;
        const unlocked = services.filter(
          (item) => item.state === "unlocked",
        ).length;
        parts.push(`解锁 ${unlocked}/${services.length}`);
      }
    }

    if (settings.keepOriginalName) parts.push(entry.originalName || entry.name);
    const name = [
      ...new Set(parts.map((part) => part.trim()).filter(Boolean)),
    ].join(" · ");
    return name || null;
  }

  function batchRenameCurrentOutput() {
    if (
      isRunning() ||
      isRegionLookupRunning() ||
      getNodeTestController()?.isRunning()
    ) {
      showToast("请等待当前转换、地区识别或节点测试完成", true);
      return;
    }
    const entries = getFilteredOutputEntries();
    if (entries.length === 0) return;

    let renamed = 0;
    for (const entry of entries) {
      const name = buildBatchRenameName(entry);
      if (!name || name === entry.name) continue;
      const node: ProxyNode = { ...entry.node, name } as ProxyNode;
      const encoded = encodeProxyNode(node);
      entry.node = node;
      entry.name = name;
      entry.uri = encoded.uri;
      entry.conversionStatus = encoded.status;
      entry.conversionDiagnostics = encoded.diagnostics;
      renamed++;
    }
    if (renamed > 0) {
      renderOutputFilter();
    }
    if (renamed === 0) {
      showToast("没有可用的已识别地区或测试结果；请检查重命名勾选项", true);
      return;
    }
    showToast(
      `批量重命名完成：${renamed}/${entries.length} 个节点`,
    );
  }

  function removeOutputEntries(entryIds: string[]): void {
    if (entryIds.length === 0) return;
    const removed = new Set(entryIds);
    const entries = getOutputEntries().filter(
      (entry) => !removed.has(entry.id),
    );
    setOutputEntries(entries);
    renderOutputFilter();
  }

  const CLEANING_TEST_KINDS: NodeTestKind[] = [
    "tcping",
    "url204",
    "bandwidth",
    "entry",
    "exit",
    "unlock",
  ];

  // 仅按已完成的节点级测试结果清理；TCPing/204 延迟超限或带宽低于阈值也按不合格处理。
  function hasFailedTestResult(entryId: string): boolean {
    return CLEANING_TEST_KINDS.some((kind) => {
      const result = getNodeTestController()?.getResult(entryId, kind);
      if (!result) return false;
      if (result.state === "error" || result.result?.success === false)
        return true;
      if (result.state !== "done") return false;
      if (kind === "tcping") {
        return (
          typeof result.result?.latencyMs === "number" &&
          result.result.latencyMs >
            getCleaningSettings().tcpingFailureThresholdMs
        );
      }
      if (kind === "url204") {
        return (
          typeof result.result?.latencyMs === "number" &&
          result.result.latencyMs >
            getCleaningSettings().url204FailureThresholdMs
        );
      }
      return (
        kind === "bandwidth" &&
        (result.result?.downloadMbps ?? 0) <
          getCleaningSettings().bandwidthFailureThresholdMbps
      );
    });
  }

  // 在当前筛选出的全部节点中按语义指纹识别重复项，并保留每组第一条。
  function getDuplicateOutputEntryIds(): string[] {
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const entry of getFilteredOutputEntries()) {
      const fingerprint = semanticFingerprint(entry.node);
      if (seen.has(fingerprint)) duplicates.push(entry.id);
      else seen.add(fingerprint);
    }
    return duplicates;
  }

  function cleaningIsBlocked(): boolean {
    return (
      isRunning() ||
      isRegionLookupRunning() ||
      getNodeTestController()?.isRunning() === true
    );
  }

  function refreshCleaningButtons(): void {
    const disabled =
      getFilteredOutputEntries().length === 0 || cleaningIsBlocked();
    dom.cleanFailedNodesButton.disabled = disabled;
    dom.cleanDuplicateNodesButton.disabled = disabled;
  }

  function deleteFailedTestNodes(): void {
    if (cleaningIsBlocked()) {
      showToast("请等待当前转换、地区识别或节点测试完成", true);
      return;
    }
    const failedIds = getFilteredOutputEntries()
      .filter((entry) => hasFailedTestResult(entry.id))
      .map((entry) => entry.id);
    if (failedIds.length === 0) {
      showToast("没有测试不合格节点");
      return;
    }
    removeOutputEntries(failedIds);
    showToast(`已删除 ${failedIds.length} 个测试不合格节点`);
  }

  function deleteDuplicateOutputNodes(): void {
    if (cleaningIsBlocked()) {
      showToast("请等待当前转换、地区识别或节点测试完成", true);
      return;
    }
    const duplicateIds = getDuplicateOutputEntryIds();
    if (duplicateIds.length === 0) {
      showToast("没有重复节点");
      return;
    }
    removeOutputEntries(duplicateIds);
    showToast(`已删除 ${duplicateIds.length} 个重复节点`);
  }
  return {
    batchRenameCurrentOutput,
    refreshCleaningButtons,
    deleteFailedTestNodes,
    deleteDuplicateOutputNodes,
  };
}
