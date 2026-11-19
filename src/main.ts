import type { ProxyProtocol } from "./core/model/proxy-node.ts";
import {
  initNodeTestUi,
  refreshNodeTestButtons,
  type NodeTestController,
  type NodeTestResponse,
} from "./node-test.ts";
import type {
  BatchRenameSettings,
  CategorizedOutput,
  CleaningSettings,
  OutputTableColumn,
} from "./ui/types.ts";
import { dom } from "./ui/dom.ts";
import { createConversionController } from "./ui/conversion-controller.ts";
import { createImportController } from "./ui/import-controller.ts";
import { createOutputMaintenance } from "./ui/output-maintenance.ts";
import { createOutputActions } from "./ui/output-actions.ts";
import { createRegionController } from "./ui/region-controller.ts";
import { createOutputFilter } from "./ui/output-filter.ts";
import { createOutputLayout } from "./ui/output-layout.ts";
import { createOutputTableView } from "./ui/output-table-view.ts";
import { createSubscriptionFetcher } from "./ui/subscription-fetcher.ts";
import { createStatusUi } from "./ui/status.ts";
import { createSettingsNavigation } from "./ui/settings-navigation.ts";
import {
  OUTPUT_COLUMN_GROUPS,
  OUTPUT_COLUMN_GROUP_BY_KEY,
  OUTPUT_PROTOCOLS,
} from "./ui/output-options.ts";
import type { OutputColumnGroupId } from "./ui/output-options.ts";
import {
  DEFAULT_CLEANING_SETTINGS,
  loadBatchRenameSettings,
  loadCleaningSettings,
  loadOutputColumnVisibility,
  normalizeCleaningThreshold,
  saveBatchRenameSettings,
  saveCleaningSettings,
  saveOutputColumnVisibility,
} from "./ui/settings-store.ts";

let outputColumnVisibility = loadOutputColumnVisibility();
let outputUris: string[] = [];
let outputEntries: CategorizedOutput[] = [];
let nodeTestController: NodeTestController | null = null;
let batchRenameSettings = loadBatchRenameSettings();
let cleaningSettings = loadCleaningSettings();
let outputTableExportInProgress = false;
let outputTableView: ReturnType<typeof createOutputTableView> | null = null;
let conversionController: ReturnType<typeof createConversionController> | null =
  null;

function isRunning(): boolean {
  return conversionController?.isRunning() ?? false;
}

function scheduleOutputFilterRender() {
  outputTableView?.scheduleOutputFilterRender();
}

function getProtocolLabel(protocol: ProxyProtocol): string {
  return (
    OUTPUT_PROTOCOLS.find((item) => item.value === protocol)?.label ??
    protocol.toUpperCase()
  );
}

function formatSpeed(mbps: number): string {
  return mbps < 1
    ? `${(mbps * 1_000).toFixed(2)}Kbps`
    : `${mbps.toFixed(2)}Mbps`;
}

function displayUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    return `${url.protocol}//${url.host}${url.pathname}${url.search ? "?…" : ""}`;
  } catch {
    return "无效地址";
  }
}

function cdnRenameLabel(
  provider: string | undefined,
  kind: "entry" | "exit",
): string {
  const role = kind === "entry" ? "\u5165\u53e3" : "\u51fa\u53e3";
  return `${provider === "Cloudflare" ? "CF" : "\u975eCF"}${role}`;
}

function detectionIps(
  result: NodeTestResponse | undefined,
  kind: "entry" | "exit",
): string[] {
  const addresses =
    kind === "entry"
      ? (result?.entryIps ?? [])
      : result?.exitIp
        ? [result.exitIp]
        : [];
  return [
    ...new Set(addresses.map((address) => address.trim()).filter(Boolean)),
  ];
}

function syncFetchConcurrencyInput() {
  const percent = dom.fetchConcurrencyMode.value === "percent";
  dom.fetchConcurrency.title = percent
    ? "按本次远程请求数的百分比计算，实际并发不会超过本次请求数"
    : "固定并发数量";
}

function shouldSkipCertificateVerification(): boolean {
  return dom.skipCertificateVerification.checked;
}

function updateBusyUi(busy: boolean) {
  if (busy) setInputDropTarget(false);
  refreshCleaningButtons();
  dom.convertButton.disabled = false;
  dom.urls.disabled = busy;
  dom.importClipboardButton.disabled = busy;
  dom.importFileButton.disabled = busy;
  dom.importQrButton.disabled = busy;
  dom.userAgentSelect.disabled = busy;
  dom.customUserAgent.disabled = busy;
  dom.fetchConcurrency.disabled = busy;
  dom.fetchConcurrencyMode.disabled = busy;
  dom.maxRedirects.disabled = busy;
  dom.remoteTimeoutSeconds.disabled = busy;
  dom.remoteSubscriptionFetchEnabled.disabled = busy;
  dom.entryRegionConcurrency.disabled =
    busy || regionController.isLookupRunning();
  dom.exitRegionConcurrency.disabled =
    busy || regionController.isLookupRunning();
  dom.includeLossyOutput.disabled = busy;
  dom.skipCertificateVerification.disabled = busy;
  dom.convertButton.classList.toggle("busy", busy);
  dom.convertLabel.textContent = busy ? "取消处理" : "开始转换";
  setProcessingStatus(busy ? "处理中" : "已完成", busy ? "running" : "done");
}

function outputColumnGroupForKey(key: string): OutputColumnGroupId {
  if (key.startsWith("service:")) return "unlock";
  return OUTPUT_COLUMN_GROUP_BY_KEY.get(key) ?? "basic";
}

function renderOutputColumnVisibilityOptions() {
  const columns = getOutputTableColumns();
  const columnsByGroup = new Map<OutputColumnGroupId, OutputTableColumn[]>(
    OUTPUT_COLUMN_GROUPS.map((group) => [group.id, []]),
  );
  for (const column of columns)
    columnsByGroup.get(outputColumnGroupForKey(column.key))?.push(column);

  for (const group of OUTPUT_COLUMN_GROUPS) {
    const options = dom.outputColumnVisibilityGroups.find(
      (container) => container.dataset.outputColumnGroup === group.id,
    );
    if (!options) continue;
    const groupColumns = columnsByGroup.get(group.id) ?? [];
    const groupToggleLabel = document.createElement("label");
    groupToggleLabel.className = "settings-row output-column-master-option";
    const groupToggleText = document.createElement("span");
    groupToggleText.textContent = "全部显示";
    const groupToggle = document.createElement("input");
    groupToggle.type = "checkbox";
    groupToggle.className = "settings-toggle";
    groupToggle.disabled = groupColumns.length === 0;
    groupToggle.setAttribute("aria-label", `显示全部${group.label}列`);
    const syncGroupToggle = () => {
      const visibleCount = groupColumns.filter(
        (column) => outputColumnVisibility[column.key] !== false,
      ).length;
      groupToggle.checked =
        groupColumns.length > 0 && visibleCount === groupColumns.length;
      groupToggle.indeterminate =
        visibleCount > 0 && visibleCount < groupColumns.length;
    };
    syncGroupToggle();
    groupToggle.addEventListener("change", () => {
      for (const column of groupColumns)
        outputColumnVisibility[column.key] = groupToggle.checked;
      options
        .querySelectorAll<HTMLInputElement>("input[data-output-column-key]")
        .forEach((checkbox) => {
          checkbox.checked = groupToggle.checked;
        });
      groupToggle.indeterminate = false;
      saveOutputColumnVisibility(outputColumnVisibility);
      renderOutputFilter();
    });
    groupToggleLabel.append(groupToggleText, groupToggle);
    const groupOptions = groupColumns.map((column) => {
      const option = document.createElement("label");
      option.className = "test-service-option";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = outputColumnVisibility[column.key] !== false;
      checkbox.dataset.outputColumnKey = column.key;
      checkbox.setAttribute(
        "aria-label",
        `显示${column.settingsLabel ?? column.label}列`,
      );
      checkbox.addEventListener("change", () => {
        outputColumnVisibility[column.key] = checkbox.checked;
        syncGroupToggle();
        saveOutputColumnVisibility(outputColumnVisibility);
        renderOutputFilter();
      });
      const name = document.createElement("span");
      name.textContent = column.settingsLabel ?? column.label;
      option.append(checkbox, name);
      return option;
    });
    options.replaceChildren(groupToggleLabel, ...groupOptions);
  }
}

function renderOutputFilter(updateSummary = true) {
  const filteredEntries = getFilteredOutputEntries();
  const uris = filteredEntries.map((entry) => entry.uri);
  const columnsChanged = renderOutputTableHeader();
  if (updateSummary || columnsChanged) renderOutputTableFooter(filteredEntries);
  renderOutputTableRows(true);
  dom.outputTableWrap.hidden = false;

  outputFilterController.updateSettingsSummaries();
  dom.entryRegionConcurrency.disabled =
    isRunning() || regionController.isLookupRunning();
  dom.exitRegionConcurrency.disabled =
    isRunning() || regionController.isLookupRunning();
  dom.copyButton.disabled = uris.length === 0;
  dom.exportTableButton.disabled =
    uris.length === 0 || outputTableExportInProgress;
  dom.exportTablePngButton.disabled =
    uris.length === 0 || outputTableExportInProgress;
  dom.saveButton.disabled = uris.length === 0;
  dom.batchRenameButton.disabled =
    uris.length === 0 ||
    isRunning() ||
    regionController.isLookupRunning() ||
    nodeTestController?.isRunning() === true;
  refreshNodeTestButtons(uris.length > 0);
  refreshCleaningButtons();
}

function bindEvents() {
  const cleaningThresholdBindings: Array<
    [HTMLInputElement, keyof CleaningSettings, number]
  > = [
    [dom.cleanTcpingThreshold, "tcpingFailureThresholdMs", 120_000],
    [dom.cleanUrl204Threshold, "url204FailureThresholdMs", 120_000],
    [dom.cleanBandwidthThreshold, "bandwidthFailureThresholdMbps", 10_000],
  ];
  for (const [input, key, maximum] of cleaningThresholdBindings) {
    input.value = String(cleaningSettings[key]);
    input.addEventListener("change", () => {
      cleaningSettings = {
        ...cleaningSettings,
        [key]: normalizeCleaningThreshold(
          input.value,
          DEFAULT_CLEANING_SETTINGS[key],
          maximum,
        ),
      };
      input.value = String(cleaningSettings[key]);
      saveCleaningSettings(cleaningSettings);
    });
  }

  const batchRenameInputBindings: Array<
    [keyof BatchRenameSettings, HTMLInputElement]
  > = [
    ["region", dom.batchRenameRegion],
    ["entry", dom.batchRenameEntry],
    ["exit", dom.batchRenameExit],
    ["tcping", dom.batchRenameTcping],
    ["url204", dom.batchRenameUrl204],
    ["averageSpeed", dom.batchRenameAverageSpeed],
    ["peakSpeed", dom.batchRenamePeakSpeed],
    ["unlockSummary", dom.batchRenameUnlockSummary],
    ["keepOriginalName", dom.batchRenameKeepOriginalName],
  ];
  for (const [key, input] of batchRenameInputBindings) {
    input.checked = batchRenameSettings[key];
    input.addEventListener("change", () => {
      batchRenameSettings = {
        ...batchRenameSettings,
        [key]: input.checked,
      };
      saveBatchRenameSettings(batchRenameSettings);
    });
  }

  dom.settingsButton.addEventListener("click", () => {
    renderOutputFilterSettingsOptions();
    settingsNavigation.showSettingsHome();
    dom.settingsDialog.showModal();
    dom.settingsHomeSearch.focus();
  });
  dom.settingsDialogClose.addEventListener("click", () =>
    dom.settingsDialog.close(),
  );
  dom.settingsDialog.addEventListener("click", (event) => {
    if (event.target === dom.settingsDialog) dom.settingsDialog.close();
  });
  dom.settingsBackHome.addEventListener("click", () => {
    settingsNavigation.showSettingsHome();
    dom.settingsHomeSearch.focus();
  });
  dom.settingsHomeSearch.addEventListener(
    "input",
    settingsNavigation.filterSettingsHome,
  );
  dom.settingsDetailSearch.addEventListener(
    "input",
    settingsNavigation.filterSettingsSubnav,
  );
  dom.settingsTabs.forEach((tab) => {
    tab.addEventListener("click", () =>
      settingsNavigation.selectSettingsCategory(
        tab.dataset.settingsTab ?? "remote-fetch",
      ),
    );
  });
  dom.settingsSubnavButtons.forEach((button) =>
    button.addEventListener("click", () =>
      settingsNavigation.navigateSettingsAnchor(button),
    ),
  );
  dom.batchRenameButton.addEventListener("click", batchRenameCurrentOutput);
  dom.cleanFailedNodesButton.addEventListener("click", deleteFailedTestNodes);
  dom.cleanDuplicateNodesButton.addEventListener(
    "click",
    deleteDuplicateOutputNodes,
  );

  dom.convertButton.addEventListener("click", () => {
    if (isRunning()) conversionController?.cancelConversion();
    else void conversionController?.startConversion();
  });
  dom.clearLogButton.addEventListener("click", clearLog);
  dom.importClipboardButton.addEventListener(
    "click",
    () => void importClipboard(),
  );
  dom.importFileButton.addEventListener("click", () => void importFile());
  bindInputFileDrop();
  dom.importQrButton.addEventListener("click", () => void importQrCode());
  dom.qrScannerClose.addEventListener("click", closeQrScanner);
  dom.qrScannerCancel.addEventListener("click", closeQrScanner);
  dom.qrScanScreenButton.addEventListener(
    "click",
    () => void scanFullScreens(),
  );
  dom.qrSelectImageButton.addEventListener("click", () =>
    dom.qrImageInput.click(),
  );
  dom.qrScanCameraButton.addEventListener("click", () => void startQrCamera());
  dom.qrImageInput.addEventListener("change", handleQrImageSelection);
  dom.qrScannerRetry.addEventListener("click", () => void startQrCamera());
  dom.qrScannerSourceBack.addEventListener("click", returnToQrSourceOptions);
  dom.qrScannerDialog.addEventListener("close", closeQrScanner);
  dom.qrScannerDialog.addEventListener("click", (event) => {
    if (event.target === dom.qrScannerDialog) closeQrScanner();
  });
  syncFetchConcurrencyInput();
  dom.fetchConcurrencyMode.addEventListener("change", () => {
    syncFetchConcurrencyInput();
    if (!dom.validation.hidden) setValidation();
  });
  dom.outputColumnAutoFitButton.addEventListener(
    "click",
    autoFitOutputColumnWidths,
  );
  outputFilterController.bindEvents();
  dom.entryRegionConcurrency.addEventListener(
    "change",
    updateEntryRegionConcurrency,
  );
  dom.exitRegionConcurrency.addEventListener(
    "change",
    updateExitRegionConcurrency,
  );
  dom.chooseEntryGeoIpDatabaseButton.addEventListener(
    "click",
    () => void chooseEntryGeoIpDatabase(),
  );
  dom.chooseExitGeoIpDatabaseButton.addEventListener(
    "click",
    () => void chooseExitGeoIpDatabase(),
  );
  dom.clearEntryGeoIpDatabaseButton.addEventListener(
    "click",
    clearEntryGeoIpDatabase,
  );
  dom.clearExitGeoIpDatabaseButton.addEventListener(
    "click",
    clearExitGeoIpDatabase,
  );
  dom.copyButton.addEventListener("click", () => void copyFilteredOutput());
  dom.exportTableButton.addEventListener(
    "click",
    () => void saveOutputTableAsExcel(),
  );
  dom.exportTablePngButton.addEventListener(
    "click",
    () => void saveOutputTableAsPng(),
  );
  dom.saveButton.addEventListener("click", () => void saveFilteredOutput());
  dom.urls.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      void conversionController?.startConversion();
    }
  });

  dom.userAgentSelect.addEventListener("change", () => {
    dom.customUserAgent.hidden = dom.userAgentSelect.value !== "custom";
    if (!dom.customUserAgent.hidden) dom.customUserAgent.focus();
  });

  dom.includeLossyOutput.addEventListener("change", () =>
    conversionController?.refreshForConversionSettingChange(),
  );

  for (const input of [
    dom.fetchConcurrency,
    dom.maxRedirects,
    dom.remoteTimeoutSeconds,
  ]) {
    input.addEventListener("input", () => {
      if (!dom.validation.hidden) setValidation();
    });
  }

  dom.urls.addEventListener("input", () => {
    if (!dom.validation.hidden) setValidation();
  });

  nodeTestController = initNodeTestUi({
    getEntries: () =>
      getFilteredOutputEntries().map((entry) => ({
        id: entry.id,
        name: entry.name,
        server: entry.server,
        port: entry.port,
        protocol: entry.protocol,
        node: entry.node,
      })),
    onResultsChanged: (entryId, kind) => {
      scheduleOutputFilterRender();
      refreshCleaningButtons();
      queueDetectedIpRegionLookups(entryId, kind);
    },
    onTestStarted: scheduleOutputFilterRender,
    onTestProgress: updateNodeTestProgress,
  });
  renderLinkRegionSettings();
  renderOutputFilter();
  bindPanelResizers();
  bindOutputTableColumnResizers();
  applyPanelRatios();
}

const {
  setValidation,
  showToast,
  appendLog,
  clearLog,
  setProcessingStatus,
  updateProgress,
  updateNodeTestProgress,
} = createStatusUi(isRunning);
const settingsNavigation = createSettingsNavigation(
  renderOutputColumnVisibilityOptions,
);
const inputController = createImportController({
  dom,
  isRunning,
  setValidation,
  showToast,
});
const {
  readImportInput,
  importClipboard,
  importFile,
  setInputDropTarget,
  bindInputFileDrop,
  importQrCode,
  closeQrScanner,
  scanFullScreens,
  startQrCamera,
  handleQrImageSelection,
  returnToQrSourceOptions,
} = inputController;
const outputFilterController = createOutputFilter({
  dom,
  getOutputEntries: () => outputEntries,
  renderOutputFilter: () => renderOutputFilter(),
  showToast,
});
const {
  getFilteredOutputEntries,
  getFilteredOutputUris,
  isOutputFilterActive,
  renderOutputFilterSettingsOptions,
} = outputFilterController;
const regionController = createRegionController({
  dom,
  getOutputEntries: () => outputEntries,
  getNodeTestController: () => nodeTestController,
  isRunning,
  isCountryFilterEnabled: () =>
    outputFilterController.getOutputFilter().countriesEnabled,
  renderOutputFilter,
  scheduleOutputFilterRender,
  detectionIps,
  appendLog,
  showToast,
});
const {
  renderLinkRegionSettings,
  updateEntryRegionConcurrency,
  updateExitRegionConcurrency,
  chooseEntryGeoIpDatabase,
  chooseExitGeoIpDatabase,
  clearEntryGeoIpDatabase,
  clearExitGeoIpDatabase,
  queueDetectedIpRegionLookups,
} = regionController;
const subscriptionFetcher = createSubscriptionFetcher({
  isCancelled: () => conversionController?.isCancelled() ?? false,
  shouldSkipCertificateVerification,
  appendLog,
  displayUrl,
});
const {
  runWithConcurrency,
  fetchSubscriptionWithFallback,
  cancelActiveRequests,
} = subscriptionFetcher;
const outputMaintenance = createOutputMaintenance({
  dom,
  getBatchRenameSettings: () => batchRenameSettings,
  getCleaningSettings: () => cleaningSettings,
  getOutputEntries: () => outputEntries,
  setOutputEntries: (entries) => {
    outputEntries = entries;
  },
  getOutputUris: () => outputUris,
  setOutputUris: (uris) => {
    outputUris = uris;
  },
  getFilteredOutputEntries,
  getNodeTestController: () => nodeTestController,
  isRunning,
  isRegionLookupRunning: () => regionController.isLookupRunning(),
  renderOutputFilter,
  showToast,
  cdnRenameLabel,
  formatSpeed,
});
const {
  batchRenameCurrentOutput,
  refreshCleaningButtons,
  deleteFailedTestNodes,
  deleteDuplicateOutputNodes,
} = outputMaintenance;
const outputActions = createOutputActions({
  getFilteredOutputEntries,
  getFilteredOutputUris,
  isOutputFilterActive,
  captureOutputTableSnapshotForExport: () =>
    outputTableView!.captureOutputTableSnapshotForExport(),
  setExportInProgress: (inProgress) => {
    outputTableExportInProgress = inProgress;
    const disabled = inProgress || getFilteredOutputEntries().length === 0;
    dom.exportTableButton.disabled = disabled;
    dom.exportTablePngButton.disabled = disabled;
  },
  showToast,
});
const {
  copyFilteredOutput,
  saveFilteredOutput,
  saveOutputTableAsExcel,
  saveOutputTableAsPng,
} = outputActions;
const outputLayout = createOutputLayout({
  dom,
  getRenderedOutputColumns: () =>
    outputTableView?.getRenderedOutputColumns() ?? [],
  getFilteredOutputEntries,
  renderOutputTableRow: (entry, index) =>
    outputTableView!.renderOutputTableRow(entry, index),
  handleOutputTableScroll: () => outputTableView?.handleOutputTableScroll(),
  scheduleOutputTableRows: () => outputTableView?.scheduleOutputTableRows(),
});
const {
  bindOutputTableColumnResizers,
  bindPanelResizers,
  applyPanelRatios,
  autoFitOutputColumnWidths,
} = outputLayout;

outputTableView = createOutputTableView({
  dom,
  getNodeTestController: () => nodeTestController,
  getRegionController: () => regionController,
  getColumnVisibility: () => outputColumnVisibility,
  applyColumnWidths: outputLayout.applyOutputColumnWidths,
  getFilteredOutputEntries,
  getProtocolLabel,
  formatSpeed,
  detectionIps,
  renderOutputFilter: () => renderOutputFilter(),
});
const {
  getOutputTableColumns,
  renderOutputTableHeader,
  renderOutputTableFooter,
  renderOutputTableRows,
} = outputTableView;
conversionController = createConversionController({
  dom,
  readImportInput,
  runWithConcurrency,
  fetchSubscriptionWithFallback,
  cancelActiveRequests,
  shouldIncludeLossyOutput: () => dom.includeLossyOutput.checked,
  setOutputEntries: (entries) => {
    outputEntries = entries;
  },
  getOutputUris: () => outputUris,
  setOutputUris: (uris) => {
    outputUris = uris;
  },
  getNodeTestController: () => nodeTestController,
  resetRegionLookupState: regionController.resetLookupState,
  renderOutputFilter: () => renderOutputFilter(),
  enrichOutputRegions: regionController.enrichOutputRegions,
  setBusy: updateBusyUi,
  setValidation,
  showToast,
  appendLog,
  setProcessingStatus,
  updateProgress,
  displayUrl,
});
regionController.migrateSettings();
bindEvents();
