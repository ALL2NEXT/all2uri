import { OUTPUT_PROTOCOLS } from "./output-options.ts";
import type { CategorizedOutput, OutputFilter } from "./types.ts";
import type { DomElements } from "./dom.ts";
import {
  countryNameForCode,
  UNKNOWN_REGION_CODE,
} from "../core/location/region.ts";
import { loadOutputFilter, saveOutputFilter } from "./settings-store.ts";

interface OutputFilterDependencies {
  dom: DomElements;
  getOutputEntries: () => CategorizedOutput[];
  renderOutputFilter: () => void;
  showToast: (message: string, isError?: boolean) => void;
}

export function createOutputFilter({
  dom,
  getOutputEntries,
  renderOutputFilter,
  showToast,
}: OutputFilterDependencies) {
  let outputFilter: OutputFilter = loadOutputFilter();
  let draftFilterProtocols = [...outputFilter.protocols];
  let draftFilterProtocolsEnabled = outputFilter.protocolsEnabled;
  let draftFilterCountries = [...outputFilter.countries];
  let draftFilterCountriesEnabled = outputFilter.countriesEnabled;
  function outputEntryMatchesFilter(entry: CategorizedOutput): boolean {
    if (
      outputFilter.protocolsEnabled &&
      !outputFilter.protocols.includes(entry.protocol)
    )
      return false;
    if (
      outputFilter.countriesEnabled &&
      !outputFilter.countries.includes(entry.countryCode ?? UNKNOWN_REGION_CODE)
    )
      return false;
    return true;
  }

  function getFilteredOutputEntries(): CategorizedOutput[] {
    return getOutputEntries().filter(outputEntryMatchesFilter);
  }

  function getFilteredOutputUris(): string[] {
    return getFilteredOutputEntries()
      .map((entry) => entry.uri)
      .filter((uri): uri is string => typeof uri === "string" && uri.trim().length > 0);
  }

  function isOutputFilterActive(): boolean {
    return outputFilter.protocolsEnabled || outputFilter.countriesEnabled;
  }

  function availableOutputRegionCodes(): string[] {
    return [
      ...new Set([
        ...outputFilter.countries,
        ...getOutputEntries().map(
          (entry) => entry.countryCode ?? UNKNOWN_REGION_CODE,
        ),
      ]),
    ].sort((left, right) => {
      if (left === UNKNOWN_REGION_CODE) return 1;
      if (right === UNKNOWN_REGION_CODE) return -1;
      return countryNameForCode(left).localeCompare(
        countryNameForCode(right),
        "zh-CN",
      );
    });
  }

  function updateOutputFilterSettingsSummaries() {
    dom.outputFilterProtocolEnabled.checked = draftFilterProtocolsEnabled;
    dom.outputFilterProtocolSummary.textContent = !draftFilterProtocolsEnabled
      ? "未启用"
      : draftFilterProtocols.length
        ? `已选 ${draftFilterProtocols.length} 种协议`
        : "未选择协议";
    dom.outputFilterRegionEnabled.checked = draftFilterCountriesEnabled;
    dom.outputFilterRegionSummary.textContent = !draftFilterCountriesEnabled
      ? "未启用"
      : draftFilterCountries.length
        ? `已选 ${draftFilterCountries.length} 个地区`
        : "未选择地区";
    dom.outputFilterProtocolOptions
      .querySelectorAll<HTMLInputElement>("input[type='checkbox']")
      .forEach((checkbox) => {
        checkbox.disabled = !draftFilterProtocolsEnabled;
      });
    dom.outputFilterRegionOptions
      .querySelectorAll<HTMLInputElement>("input[type='checkbox']")
      .forEach((checkbox) => {
        checkbox.disabled = !draftFilterCountriesEnabled;
      });
  }

  function renderOutputFilterSettingsOptions() {
    dom.outputFilterProtocolOptions.replaceChildren();
    for (const item of OUTPUT_PROTOCOLS) {
      const optionLabel = document.createElement("label");
      optionLabel.className = "output-filter-option";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = item.value;
      checkbox.checked = draftFilterProtocols.includes(item.value);
      checkbox.setAttribute("aria-label", `协议类型：${item.label}`);
      const optionName = document.createElement("span");
      optionName.textContent = item.label;
      checkbox.addEventListener("change", () => {
        const selected = new Set(draftFilterProtocols);
        if (checkbox.checked) selected.add(item.value);
        else selected.delete(item.value);
        draftFilterProtocols = OUTPUT_PROTOCOLS.map(
          (protocol) => protocol.value,
        ).filter((protocol) => selected.has(protocol));
        updateOutputFilterSettingsSummaries();
      });
      optionLabel.append(checkbox, optionName);
      dom.outputFilterProtocolOptions.append(optionLabel);
    }

    dom.outputFilterRegionOptions.replaceChildren();
    const regionCodes = availableOutputRegionCodes();
    if (regionCodes.length === 0) {
      const empty = document.createElement("span");
      empty.className = "output-region-empty";
      empty.textContent = "完成节点转换后，这里会显示识别到的地区。";
      dom.outputFilterRegionOptions.append(empty);
    }
    for (const code of regionCodes) {
      const optionLabel = document.createElement("label");
      optionLabel.className = "output-filter-option";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = code;
      checkbox.checked = draftFilterCountries.includes(code);
      const regionName = countryNameForCode(code);
      checkbox.setAttribute("aria-label", `地区：${regionName}`);
      const optionName = document.createElement("span");
      optionName.textContent = `${regionName} · ${code}`;
      checkbox.addEventListener("change", () => {
        const selected = new Set(draftFilterCountries);
        if (checkbox.checked) selected.add(code);
        else selected.delete(code);
        draftFilterCountries = regionCodes.filter((regionCode) =>
          selected.has(regionCode),
        );
        updateOutputFilterSettingsSummaries();
      });
      optionLabel.append(checkbox, optionName);
      dom.outputFilterRegionOptions.append(optionLabel);
    }
    updateOutputFilterSettingsSummaries();
  }

  function applyOutputFilter() {
    outputFilter = {
      protocolsEnabled: draftFilterProtocolsEnabled,
      protocols: [...draftFilterProtocols],
      countriesEnabled: draftFilterCountriesEnabled,
      countries: [...draftFilterCountries],
    };
    saveOutputFilter(outputFilter);
    renderOutputFilter();
    showToast("筛选已应用");
  }
  function bindEvents() {
    dom.outputFilterApplyButton.addEventListener("click", applyOutputFilter);
    dom.outputFilterProtocolEnabled.addEventListener("change", () => {
      draftFilterProtocolsEnabled = dom.outputFilterProtocolEnabled.checked;
      updateOutputFilterSettingsSummaries();
    });
    dom.outputFilterRegionEnabled.addEventListener("change", () => {
      draftFilterCountriesEnabled = dom.outputFilterRegionEnabled.checked;
      updateOutputFilterSettingsSummaries();
    });
  }

  return {
    getFilteredOutputEntries,
    getFilteredOutputUris,
    isOutputFilterActive,
    getOutputFilter: () => outputFilter,
    renderOutputFilterSettingsOptions,
    updateSettingsSummaries: updateOutputFilterSettingsSummaries,
    applyOutputFilter,
    bindEvents,
  };
}
