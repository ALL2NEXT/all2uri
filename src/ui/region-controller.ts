import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  countryCodeFromNodeName,
  normalizeRegionCode,
  REGION_LOOKUP_OPTIONS,
} from "../core/location/region.ts";
import type { RegionLookupMethod } from "../core/location/region.ts";
import type { CategorizedOutput } from "./types.ts";
import type { NodeTestController, NodeTestKind } from "../node-test.ts";
import { failureFrom } from "./errors.ts";
import {
  MIN_REGION_LOOKUP_CONCURRENCY,
  loadRegionSettings,
  migrateRegionSettings,
  saveEntryGeoIpDatabasePath,
  saveEntryRegionConcurrency,
  saveEntryRegionMethods,
  saveExitGeoIpDatabasePath,
  saveExitRegionConcurrency,
  saveExitRegionMethods,
} from "./settings-store.ts";
import type { DomElements } from "./dom.ts";

interface RegionControllerDependencies {
  dom: DomElements;
  getOutputEntries: () => CategorizedOutput[];
  getNodeTestController: () => NodeTestController | null;
  isRunning: () => boolean;
  isCountryFilterEnabled: () => boolean;
  renderOutputFilter: (updateSummary?: boolean) => void;
  scheduleOutputFilterRender: () => void;
  detectionIps: (
    result:
      | NonNullable<ReturnType<NodeTestController["getResult"]>>["result"]
      | undefined,
    kind: "entry" | "exit",
  ) => string[];
  appendLog: (message: string, isError?: boolean) => void;
  showToast: (message: string, isError?: boolean) => void;
}

export function createRegionController({
  dom,
  getOutputEntries,
  getNodeTestController,
  isRunning,
  isCountryFilterEnabled,
  renderOutputFilter,
  scheduleOutputFilterRender,
  detectionIps,
  appendLog,
  showToast,
}: RegionControllerDependencies) {
  const initialSettings = loadRegionSettings();
  let entryRegionMethods = initialSettings.entryMethods;
  let entryRegionConcurrency = initialSettings.entryConcurrency;
  let exitRegionMethods = initialSettings.exitMethods;
  let exitRegionConcurrency = initialSettings.exitConcurrency;
  let entryGeoIpDatabasePath = initialSettings.entryGeoIpDatabasePath;
  let exitGeoIpDatabasePath = initialSettings.exitGeoIpDatabasePath;
  let regionLookupState: "idle" | "running" | "done" | "error" = "idle";
  let regionLookupRunId = 0;
  const detectedIpRegionCodes = new Map<string, string | null>();
  const detectedIpRegionMethodsByKey = new Map<string, RegionLookupMethod>();
  const queuedDetectedIpRegions = new Map<
    string,
    { kind: "entry" | "exit"; address: string }
  >();
  const pendingDetectedIpRegions = new Set<string>();
  const reportedDetectedIpRegionErrors = new Set<RegionLookupMethod>();
  let detectedIpRegionLookupTask: Promise<void> | null = null;
  let detectedIpRegionLookupTimer: number | null = null;
  let detectedIpRegionLookupSignature = "";
  let detectedIpRegionLookupRunId = 0;
  function renderRegionLookupOptions(
    container: HTMLDivElement,
    methods: RegionLookupMethod[],
    availableOptions: typeof REGION_LOOKUP_OPTIONS,
    updateMethods: (methods: RegionLookupMethod[]) => void,
  ) {
    container.replaceChildren();
    const orderedOptions = [
      ...methods
        .map(
          (method) =>
            availableOptions.find((option) => option.value === method)!,
        )
        .filter(Boolean),
      ...availableOptions.filter((option) => !methods.includes(option.value)),
    ];
    for (const option of orderedOptions) {
      const priority = methods.indexOf(option.value);
      const row = document.createElement("div");
      row.className = "region-lookup-method-row";

      const label = document.createElement("label");
      label.className = "region-lookup-method-label";
      label.title = option.description;

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "settings-checkbox";
      checkbox.checked = priority >= 0;
      checkbox.setAttribute("aria-label", option.title);
      checkbox.addEventListener("change", () => {
        updateMethods(
          checkbox.checked
            ? [...methods, option.value]
            : methods.filter((method) => method !== option.value),
        );
      });

      const title = document.createElement("span");
      title.textContent = option.title;
      label.append(checkbox, title);

      const priorityLabel = document.createElement("span");
      priorityLabel.className = "region-lookup-priority";
      priorityLabel.textContent = priority >= 0 ? String(priority + 1) : "–";

      const moveUp = document.createElement("button");
      moveUp.className = "settings-link-button";
      moveUp.type = "button";
      moveUp.textContent = "↑";
      moveUp.disabled = priority <= 0;
      moveUp.setAttribute("aria-label", `提高${option.title}优先级`);
      moveUp.addEventListener("click", () => {
        if (priority <= 0) return;
        const reordered = [...methods];
        [reordered[priority - 1], reordered[priority]] = [
          reordered[priority],
          reordered[priority - 1],
        ];
        updateMethods(reordered);
      });

      const moveDown = document.createElement("button");
      moveDown.className = "settings-link-button";
      moveDown.type = "button";
      moveDown.textContent = "↓";
      moveDown.disabled = priority < 0 || priority >= methods.length - 1;
      moveDown.setAttribute("aria-label", `降低${option.title}优先级`);
      moveDown.addEventListener("click", () => {
        if (priority < 0 || priority >= methods.length - 1) return;
        const reordered = [...methods];
        [reordered[priority], reordered[priority + 1]] = [
          reordered[priority + 1],
          reordered[priority],
        ];
        updateMethods(reordered);
      });

      const controls = document.createElement("div");
      controls.className = "region-lookup-order-controls";
      controls.append(priorityLabel, moveUp, moveDown);
      row.append(label, controls);
      container.append(row);
    }
  }

  function updateEntryRegionMethods(methods: RegionLookupMethod[]) {
    entryRegionMethods = [...new Set(methods)];
    saveEntryRegionMethods(entryRegionMethods);
    renderEntryRegionSettings();
    queueDetectedIpRegionLookups();
    if (!isRunning() && getOutputEntries().length > 0) {
      regionLookupState = "idle";
      void enrichOutputRegions();
    }
  }

  function updateExitRegionMethods(methods: RegionLookupMethod[]) {
    exitRegionMethods = [
      ...new Set(methods.filter((method) => method !== "NODE_NAME")),
    ];
    saveExitRegionMethods(exitRegionMethods);
    renderExitRegionSettings();
    queueDetectedIpRegionLookups();
    renderOutputFilter();
  }

  function renderEntryRegionSettings() {
    renderRegionLookupOptions(
      dom.entryRegionMethods,
      entryRegionMethods,
      REGION_LOOKUP_OPTIONS,
      updateEntryRegionMethods,
    );
    const databaseName = entryGeoIpDatabasePath.split(/[\\/]/).pop();
    dom.entryGeoIpDatabaseName.textContent = databaseName || "内置 geoip.dat";
    dom.entryGeoIpDatabaseName.title =
      entryGeoIpDatabasePath || "自动使用安装包内置数据库";
    dom.clearEntryGeoIpDatabaseButton.disabled = !entryGeoIpDatabasePath;
    dom.entryRegionConcurrency.value = String(entryRegionConcurrency);
  }

  function renderExitRegionSettings() {
    const methods = REGION_LOOKUP_OPTIONS.filter(
      (option) => option.value !== "NODE_NAME",
    );
    renderRegionLookupOptions(
      dom.exitRegionMethods,
      exitRegionMethods,
      methods,
      updateExitRegionMethods,
    );
    const databaseName = exitGeoIpDatabasePath.split(/[\\/]/).pop();
    dom.exitGeoIpDatabaseName.textContent = databaseName || "内置 geoip.dat";
    dom.exitGeoIpDatabaseName.title =
      exitGeoIpDatabasePath || "自动使用安装包内置数据库";
    dom.clearExitGeoIpDatabaseButton.disabled = !exitGeoIpDatabasePath;
    dom.exitRegionConcurrency.value = String(exitRegionConcurrency);
  }

  function renderLinkRegionSettings() {
    renderEntryRegionSettings();
    renderExitRegionSettings();
  }

  function updateEntryRegionConcurrency() {
    const value = dom.entryRegionConcurrency.valueAsNumber;
    if (!Number.isInteger(value) || value < MIN_REGION_LOOKUP_CONCURRENCY) {
      dom.entryRegionConcurrency.value = String(entryRegionConcurrency);
      return;
    }
    if (entryRegionConcurrency === value) return;
    entryRegionConcurrency = value;
    saveEntryRegionConcurrency(entryRegionConcurrency);
    queueDetectedIpRegionLookups();
    if (!isRunning() && getOutputEntries().length > 0) {
      regionLookupState = "idle";
      void enrichOutputRegions();
    }
  }

  function updateExitRegionConcurrency() {
    const value = dom.exitRegionConcurrency.valueAsNumber;
    if (!Number.isInteger(value) || value < MIN_REGION_LOOKUP_CONCURRENCY) {
      dom.exitRegionConcurrency.value = String(exitRegionConcurrency);
      return;
    }
    if (exitRegionConcurrency === value) return;
    exitRegionConcurrency = value;
    saveExitRegionConcurrency(exitRegionConcurrency);
    queueDetectedIpRegionLookups();
    renderOutputFilter();
  }

  async function chooseEntryGeoIpDatabase() {
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "Xray / V2Ray GeoIP 数据库", extensions: ["dat"] }],
      });
      if (typeof selected !== "string") return;
      entryGeoIpDatabasePath = selected;
      saveEntryGeoIpDatabasePath(entryGeoIpDatabasePath);
      renderEntryRegionSettings();
      queueDetectedIpRegionLookups();
      if (!isRunning() && getOutputEntries().length > 0) {
        regionLookupState = "idle";
        void enrichOutputRegions();
      }
      renderOutputFilter();
    } catch (error) {
      showToast(failureFrom(error).message || "选择 GeoIP 数据库失败", true);
    }
  }

  async function chooseExitGeoIpDatabase() {
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "Xray / V2Ray GeoIP 数据库", extensions: ["dat"] }],
      });
      if (typeof selected !== "string") return;
      exitGeoIpDatabasePath = selected;
      saveExitGeoIpDatabasePath(exitGeoIpDatabasePath);
      renderExitRegionSettings();
      queueDetectedIpRegionLookups();
      renderOutputFilter();
    } catch (error) {
      showToast(failureFrom(error).message || "选择 GeoIP 数据库失败", true);
    }
  }

  function clearEntryGeoIpDatabase() {
    entryGeoIpDatabasePath = "";
    saveEntryGeoIpDatabasePath(entryGeoIpDatabasePath);
    renderEntryRegionSettings();
    queueDetectedIpRegionLookups();
    if (!isRunning() && getOutputEntries().length > 0) {
      regionLookupState = "idle";
      void enrichOutputRegions();
    }
    renderOutputFilter();
  }

  function clearExitGeoIpDatabase() {
    exitGeoIpDatabasePath = "";
    saveExitGeoIpDatabasePath(exitGeoIpDatabasePath);
    renderExitRegionSettings();
    queueDetectedIpRegionLookups();
    renderOutputFilter();
  }

  function detectedIpRegionKey(
    kind: "entry" | "exit",
    address: string,
  ): string {
    return `${kind}:${address}`;
  }

  async function enrichOutputRegions() {
    const runId = ++regionLookupRunId;
    const entries = [...getOutputEntries()];
    if (entries.length === 0) {
      regionLookupState = "idle";
      renderOutputFilter(isCountryFilterEnabled());
      return;
    }

    regionLookupState = entryRegionMethods.length > 0 ? "running" : "done";
    for (const entry of entries) entry.countryCode = null;
    renderOutputFilter(isCountryFilterEnabled());

    const unresolved = new Map(entries.map((entry) => [entry.id, entry]));
    let lookupFailed = false;
    for (const method of entryRegionMethods) {
      if (runId !== regionLookupRunId) return;
      if (unresolved.size === 0) break;

      if (method === "NODE_NAME") {
        for (const [id, entry] of unresolved) {
          const countryCode = countryCodeFromNodeName(
            entry.originalName || entry.name,
          );
          if (!countryCode) continue;
          entry.countryCode = countryCode;
          unresolved.delete(id);
        }
        continue;
      }

      const pendingEntries = [...unresolved.values()];
      if (pendingEntries.length === 0) break;
      try {
        const results = await invoke<
          Array<{ id: string; countryCode: string | null }>
        >("lookup_node_regions", {
          nodes: pendingEntries.map(({ id, server }) => ({ id, server })),
          lookupMethod: method,
          geoIpDatabasePath:
            method === "LOCAL_GEOIP" ? entryGeoIpDatabasePath : null,
          concurrency: entryRegionConcurrency,
        });
        if (runId !== regionLookupRunId) return;
        const resultById = new Map(
          results.map((result) => [
            result.id,
            normalizeRegionCode(result.countryCode),
          ]),
        );
        for (const [id, entry] of unresolved) {
          const countryCode = resultById.get(id);
          if (!countryCode) continue;
          entry.countryCode = countryCode;
          unresolved.delete(id);
        }
      } catch (error) {
        lookupFailed = true;
        appendLog(
          `${method === "LOCAL_GEOIP" ? "本地 GeoIP" : "远程地区 API"}查询失败：${failureFrom(error).message}`,
          true,
        );
      }
    }

    if (runId !== regionLookupRunId) return;
    regionLookupState = lookupFailed ? "error" : "done";
    renderOutputFilter(isCountryFilterEnabled());
  }

  // 按入口和出口各自启用的查询来源批量查询 IP 地区。
  async function lookupQueuedDetectedIpRegions(runId: number) {
    while (
      runId === detectedIpRegionLookupRunId &&
      queuedDetectedIpRegions.size > 0
    ) {
      const jobs = [...queuedDetectedIpRegions.values()].slice(0, 128);
      for (const job of jobs)
        queuedDetectedIpRegions.delete(
          detectedIpRegionKey(job.kind, job.address),
        );

      for (const kind of ["entry", "exit"] as const) {
        const addresses = [
          ...new Set(
            jobs.filter((job) => job.kind === kind).map((job) => job.address),
          ),
        ];
        if (addresses.length === 0) continue;
        const selectedMethods =
          kind === "entry" ? entryRegionMethods : exitRegionMethods;
        const methods = selectedMethods.filter(
          (method): method is Exclude<RegionLookupMethod, "NODE_NAME"> =>
            method !== "NODE_NAME",
        );
        const unresolved = new Set(addresses);

        for (const method of methods) {
          if (runId !== detectedIpRegionLookupRunId) return;
          if (unresolved.size === 0) break;
          try {
            const results = await invoke<
              Array<{ id: string; countryCode: string | null }>
            >("lookup_node_regions", {
              nodes: [...unresolved].map((address) => ({
                id: address,
                server: address,
              })),
              lookupMethod: method,
              geoIpDatabasePath:
                method === "LOCAL_GEOIP"
                  ? kind === "entry"
                    ? entryGeoIpDatabasePath
                    : exitGeoIpDatabasePath
                  : null,
              concurrency:
                kind === "entry"
                  ? entryRegionConcurrency
                  : exitRegionConcurrency,
            });
            if (runId !== detectedIpRegionLookupRunId) return;
            const resultById = new Map(
              results.map((result) => [
                result.id,
                normalizeRegionCode(result.countryCode),
              ]),
            );
            for (const address of unresolved) {
              const countryCode = resultById.get(address);
              if (!countryCode) continue;
              const key = detectedIpRegionKey(kind, address);
              detectedIpRegionCodes.set(key, countryCode);
              detectedIpRegionMethodsByKey.set(key, method);
              unresolved.delete(address);
            }
          } catch (error) {
            if (runId !== detectedIpRegionLookupRunId) return;
            if (!reportedDetectedIpRegionErrors.has(method)) {
              reportedDetectedIpRegionErrors.add(method);
              const methodLabel =
                method === "LOCAL_GEOIP" ? "本地 GeoIP" : "远程地区 API";
              const sideLabel = kind === "entry" ? "入口" : "出口";
              appendLog(
                `${methodLabel}查询${sideLabel} IP 地区失败：${failureFrom(error).message}`,
                true,
              );
            }
          }
        }

        if (runId !== detectedIpRegionLookupRunId) return;
        for (const address of addresses) {
          const key = detectedIpRegionKey(kind, address);
          if (!detectedIpRegionCodes.has(key))
            detectedIpRegionCodes.set(key, null);
          pendingDetectedIpRegions.delete(key);
        }
      }
      scheduleOutputFilterRender();
    }
  }

  function scheduleDetectedIpRegionLookup() {
    if (
      queuedDetectedIpRegions.size === 0 ||
      detectedIpRegionLookupTask ||
      detectedIpRegionLookupTimer !== null
    )
      return;
    detectedIpRegionLookupTimer = window.setTimeout(() => {
      detectedIpRegionLookupTimer = null;
      if (queuedDetectedIpRegions.size === 0 || detectedIpRegionLookupTask)
        return;
      const runId = detectedIpRegionLookupRunId;
      detectedIpRegionLookupTask = lookupQueuedDetectedIpRegions(runId)
        .catch((error) =>
          appendLog(
            `入口/出口 IP 地区查询失败：${failureFrom(error).message}`,
            true,
          ),
        )
        .finally(() => {
          detectedIpRegionLookupTask = null;
          scheduleDetectedIpRegionLookup();
        });
    }, 100);
  }

  function queueDetectedIpRegionLookups(
    changedEntryId?: string,
    changedKind?: NodeTestKind,
  ) {
    const linkDetectionSettings =
      getNodeTestController()?.getLinkDetectionSettings();
    const entryRegionEnabled =
      linkDetectionSettings?.entryRegionEnabled ?? true;
    const exitRegionEnabled = linkDetectionSettings?.exitRegionEnabled ?? true;
    const entryIpMethods = entryRegionMethods.filter(
      (method) => method !== "NODE_NAME",
    );
    const exitIpMethods = exitRegionMethods;
    const signature = JSON.stringify([
      entryRegionMethods,
      entryRegionConcurrency,
      exitRegionMethods,
      exitRegionConcurrency,
      entryIpMethods.includes("LOCAL_GEOIP") ? entryGeoIpDatabasePath : "",
      exitIpMethods.includes("LOCAL_GEOIP") ? exitGeoIpDatabasePath : "",
      entryRegionEnabled,
      exitRegionEnabled,
    ]);
    if (signature !== detectedIpRegionLookupSignature) {
      detectedIpRegionLookupSignature = signature;
      detectedIpRegionLookupRunId += 1;
      detectedIpRegionCodes.clear();
      detectedIpRegionMethodsByKey.clear();
      queuedDetectedIpRegions.clear();
      pendingDetectedIpRegions.clear();
      reportedDetectedIpRegionErrors.clear();
    }
    const nodeTestController = getNodeTestController();
    if (
      (entryIpMethods.length === 0 && exitIpMethods.length === 0) ||
      !nodeTestController
    )
      return;

    const candidates: Array<{ entryId: string; kind: "entry" | "exit" }> = [];
    if (changedEntryId && changedKind === "entry" && entryRegionEnabled) {
      candidates.push({ entryId: changedEntryId, kind: changedKind });
    } else if (changedEntryId && changedKind === "exit" && exitRegionEnabled) {
      candidates.push({ entryId: changedEntryId, kind: changedKind });
    } else if (!changedEntryId) {
      for (const entry of getOutputEntries()) {
        if (entryRegionEnabled)
          candidates.push({ entryId: entry.id, kind: "entry" });
        if (exitRegionEnabled)
          candidates.push({ entryId: entry.id, kind: "exit" });
      }
    }

    for (const { entryId, kind } of candidates) {
      const state = nodeTestController.getResult(entryId, kind);
      if (state?.state !== "done" || !state.result?.success) continue;
      const methods = kind === "entry" ? entryRegionMethods : exitRegionMethods;
      const ipMethods = kind === "entry" ? entryIpMethods : exitIpMethods;
      if (ipMethods.length === 0) continue;
      if (kind === "entry") {
        const nodeNameCode = methods.includes("NODE_NAME")
          ? countryCodeFromNodeName(
              getOutputEntries().find((entry) => entry.id === entryId)
                ?.originalName ?? "",
            )
          : null;
        const nodeNamePriority = methods.indexOf("NODE_NAME");
        const firstIpMethodPriority = Math.min(
          ...ipMethods.map((method) => methods.indexOf(method)),
        );
        if (
          nodeNameCode &&
          nodeNamePriority >= 0 &&
          nodeNamePriority < firstIpMethodPriority
        )
          continue;
      }
      for (const address of detectionIps(state.result, kind)) {
        const key = detectedIpRegionKey(kind, address);
        if (detectedIpRegionCodes.has(key) || pendingDetectedIpRegions.has(key))
          continue;
        queuedDetectedIpRegions.set(key, { kind, address });
        pendingDetectedIpRegions.add(key);
      }
    }

    scheduleDetectedIpRegionLookup();
  }
  return {
    renderLinkRegionSettings,
    updateEntryRegionConcurrency,
    updateExitRegionConcurrency,
    chooseEntryGeoIpDatabase,
    chooseExitGeoIpDatabase,
    clearEntryGeoIpDatabase,
    clearExitGeoIpDatabase,
    enrichOutputRegions,
    queueDetectedIpRegionLookups,
    isLookupRunning: () => regionLookupState === "running",
    resetLookupState: () => {
      regionLookupRunId += 1;
      regionLookupState = "idle";
    },
    migrateSettings: () => migrateRegionSettings(initialSettings),
    getMethods: (kind: "entry" | "exit") =>
      kind === "entry" ? entryRegionMethods : exitRegionMethods,
    getIpLookup: (kind: "entry" | "exit", address: string) => {
      const key = detectedIpRegionKey(kind, address);
      return {
        code: detectedIpRegionCodes.get(key),
        method: detectedIpRegionMethodsByKey.get(key),
        pending: pendingDetectedIpRegions.has(key),
      };
    },
  };
}
