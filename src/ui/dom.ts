function getElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`缺少界面元素 #${id}`);
  return element as T;
}

export const dom = {
  urls: getElement<HTMLTextAreaElement>("subscription-urls"),
  inputDropZone: getElement<HTMLDivElement>("input-drop-zone"),
  inputDropHint: getElement<HTMLDivElement>("input-drop-hint"),
  settingsButton: getElement<HTMLButtonElement>("settings-button"),
  settingsDialog: getElement<HTMLDialogElement>("app-settings-dialog"),
  settingsDialogClose: getElement<HTMLButtonElement>("settings-dialog-close"),
  settingsHome: getElement<HTMLElement>("settings-home"),
  settingsHomeSearch: getElement<HTMLInputElement>("settings-home-search"),
  settingsHomeEmpty: getElement<HTMLParagraphElement>("settings-home-empty"),
  settingsDetail: getElement<HTMLDivElement>("settings-detail"),
  settingsDetailSearch: getElement<HTMLInputElement>("settings-detail-search"),
  settingsBackHome: getElement<HTMLButtonElement>("settings-back-home"),
  settingsContent: getElement<HTMLDivElement>("settings-content"),
  settingsTabs: Array.from(
    document.querySelectorAll<HTMLButtonElement>(
      ".settings-home-card[data-settings-tab]",
    ),
  ),
  settingsPanes: Array.from(
    document.querySelectorAll<HTMLElement>("[data-settings-pane]"),
  ),
  settingsSubnavs: Array.from(
    document.querySelectorAll<HTMLElement>("[data-settings-subnav]"),
  ),
  settingsSubnavButtons: Array.from(
    document.querySelectorAll<HTMLButtonElement>("[data-settings-anchor]"),
  ),
  outputColumnVisibilityGroups: Array.from(
    document.querySelectorAll<HTMLDivElement>("[data-output-column-group]"),
  ),
  importClipboardButton: getElement<HTMLButtonElement>(
    "import-clipboard-button",
  ),
  importFileButton: getElement<HTMLButtonElement>("import-file-button"),
  importQrButton: getElement<HTMLButtonElement>("import-qr-button"),
  qrScannerDialog: getElement<HTMLDialogElement>("qr-scanner-dialog"),
  qrScannerSourceOptions: getElement<HTMLElement>("qr-scanner-source-options"),
  qrScanScreenButton: getElement<HTMLButtonElement>("qr-scan-screen-button"),
  qrSelectImageButton: getElement<HTMLButtonElement>("qr-select-image-button"),
  qrScanCameraButton: getElement<HTMLButtonElement>("qr-scan-camera-button"),
  qrImageInput: getElement<HTMLInputElement>("qr-image-input"),
  qrScannerPreview: getElement<HTMLDivElement>("qr-scanner-preview"),
  qrScannerVideo: getElement<HTMLVideoElement>("qr-scanner-video"),
  qrScannerStatus: getElement<HTMLParagraphElement>("qr-scanner-status"),
  qrScannerClose: getElement<HTMLButtonElement>("qr-scanner-close"),
  qrScannerCancel: getElement<HTMLButtonElement>("qr-scanner-cancel"),
  qrScannerSourceBack: getElement<HTMLButtonElement>("qr-scanner-source-back"),
  qrScannerRetry: getElement<HTMLButtonElement>("qr-scanner-retry"),
  workspace: getElement<HTMLElement>("workspace"),
  panelResizers: Array.from(
    document.querySelectorAll<HTMLElement>(".panel-resizer"),
  ),
  validation: getElement<HTMLDivElement>("validation-message"),
  userAgentSelect: getElement<HTMLSelectElement>("user-agent-select"),
  customUserAgent: getElement<HTMLInputElement>("custom-user-agent"),
  remoteSubscriptionFetchEnabled: getElement<HTMLInputElement>(
    "remote-subscription-fetch-enabled",
  ),
  fetchConcurrency: getElement<HTMLInputElement>("fetch-concurrency"),
  fetchConcurrencyMode: getElement<HTMLSelectElement>("fetch-concurrency-mode"),
  maxRedirects: getElement<HTMLInputElement>("max-redirects"),
  remoteTimeoutSeconds: getElement<HTMLInputElement>("remote-timeout-seconds"),
  entryRegionMethods: getElement<HTMLDivElement>("entry-region-methods"),
  entryRegionConcurrency: getElement<HTMLInputElement>(
    "entry-region-concurrency",
  ),
  entryGeoIpDatabaseName: getElement<HTMLSpanElement>(
    "entry-geoip-database-name",
  ),
  chooseEntryGeoIpDatabaseButton: getElement<HTMLButtonElement>(
    "choose-entry-geoip-database",
  ),
  clearEntryGeoIpDatabaseButton: getElement<HTMLButtonElement>(
    "clear-entry-geoip-database",
  ),
  exitRegionMethods: getElement<HTMLDivElement>("exit-region-methods"),
  exitRegionConcurrency: getElement<HTMLInputElement>(
    "exit-region-concurrency",
  ),
  exitGeoIpDatabaseName: getElement<HTMLSpanElement>(
    "exit-geoip-database-name",
  ),
  chooseExitGeoIpDatabaseButton: getElement<HTMLButtonElement>(
    "choose-exit-geoip-database",
  ),
  clearExitGeoIpDatabaseButton: getElement<HTMLButtonElement>(
    "clear-exit-geoip-database",
  ),
  cleanTcpingThreshold: getElement<HTMLInputElement>("clean-tcping-threshold"),
  cleanUrl204Threshold: getElement<HTMLInputElement>("clean-url204-threshold"),
  cleanBandwidthThreshold: getElement<HTMLInputElement>(
    "clean-bandwidth-threshold",
  ),
  skipCertificateVerification: getElement<HTMLInputElement>(
    "skip-certificate-verification",
  ),
  convertButton: getElement<HTMLButtonElement>("convert-button"),
  convertLabel:
    getElement<HTMLSpanElement>(
      "convert-button",
    ).querySelector<HTMLSpanElement>(".button-label")!,
  progressCopy: getElement<HTMLDivElement>("progress-copy"),
  progressBar: getElement<HTMLSpanElement>("progress-bar"),
  processingStatus: getElement<HTMLSpanElement>("processing-status"),
  logList: getElement<HTMLDivElement>("log-list"),
  clearLogButton: getElement<HTMLButtonElement>("clear-log-button"),
  cleanFailedNodesButton: getElement<HTMLButtonElement>(
    "clean-failed-nodes-button",
  ),
  cleanDuplicateNodesButton: getElement<HTMLButtonElement>(
    "clean-duplicate-nodes-button",
  ),
  batchRenameButton: getElement<HTMLButtonElement>("batch-rename-button"),
  batchRenameRegion: getElement<HTMLInputElement>("batch-rename-region"),
  batchRenameEntry: getElement<HTMLInputElement>("batch-rename-entry"),
  batchRenameExit: getElement<HTMLInputElement>("batch-rename-exit"),
  batchRenameTcping: getElement<HTMLInputElement>("batch-rename-tcping"),
  batchRenameUrl204: getElement<HTMLInputElement>("batch-rename-url204"),
  batchRenameAverageSpeed: getElement<HTMLInputElement>(
    "batch-rename-average-speed",
  ),
  batchRenamePeakSpeed: getElement<HTMLInputElement>("batch-rename-peak-speed"),
  batchRenameUnlockSummary: getElement<HTMLInputElement>(
    "batch-rename-unlock-summary",
  ),
  batchRenameKeepOriginalName: getElement<HTMLInputElement>(
    "batch-rename-keep-original-name",
  ),
  outputColumnAutoFitButton: getElement<HTMLButtonElement>(
    "output-column-auto-fit-button",
  ),
  outputTableWrap: getElement<HTMLDivElement>("output-table-wrap"),
  outputTable: getElement<HTMLTableElement>("output-table"),
  outputTableColumns: getElement<HTMLElement>("output-table-columns"),
  outputTableHead: getElement<HTMLTableSectionElement>("output-table-head"),
  outputTableBody: getElement<HTMLTableSectionElement>("output-table-body"),
  outputTableFoot: getElement<HTMLTableSectionElement>("output-table-foot"),
  outputFilterApplyButton: getElement<HTMLButtonElement>(
    "output-filter-apply-button",
  ),
  outputFilterProtocolEnabled: getElement<HTMLInputElement>(
    "output-filter-protocol-enabled",
  ),
  outputFilterProtocolOptions: getElement<HTMLDivElement>(
    "output-filter-protocol-options",
  ),
  outputFilterProtocolSummary: getElement<HTMLSpanElement>(
    "output-filter-protocol-summary",
  ),
  outputFilterRegionEnabled: getElement<HTMLInputElement>(
    "output-filter-region-enabled",
  ),
  outputFilterRegionOptions: getElement<HTMLDivElement>(
    "output-filter-region-options",
  ),
  outputFilterRegionSummary: getElement<HTMLSpanElement>(
    "output-filter-region-summary",
  ),
  copyButton: getElement<HTMLButtonElement>("copy-button"),
  exportTableButton: getElement<HTMLButtonElement>("export-table-button"),
  exportTablePngButton: getElement<HTMLButtonElement>(
    "export-table-png-button",
  ),
  saveButton: getElement<HTMLButtonElement>("save-button"),
  toast: getElement<HTMLDivElement>("toast"),
};

export type DomElements = typeof dom;
