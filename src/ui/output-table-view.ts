import type { DomElements } from "./dom.ts";
import type { CategorizedOutput, OutputTableColumn } from "./types.ts";
import type {
  NodeTestController,
  NodeTestKind,
  NodeTestResponse,
  UnlockServiceDefinition,
} from "../node-test.ts";
import type { RegionLookupMethod } from "../core/location/region.ts";
import {
  countryCodeFromNodeName,
  countryNameForCode,
  UNKNOWN_REGION_CODE,
} from "../core/location/region.ts";
import {
  OUTPUT_COLUMN_DEFAULT_WIDTHS,
  OUTPUT_TABLE_OVERSCAN_ROWS,
  OUTPUT_TABLE_ROW_HEIGHT_ESTIMATE,
  OUTPUT_TABLE_VIRTUALIZATION_THRESHOLD,
} from "./output-options.ts";
import { captureOutputTableSnapshot } from "../core/output-table-snapshot.ts";

interface RegionControllerView {
  getMethods: (kind: "entry" | "exit") => RegionLookupMethod[];
  getIpLookup: (
    kind: "entry" | "exit",
    address: string,
  ) => {
    code: string | null | undefined;
    method: RegionLookupMethod | undefined;
    pending: boolean;
  };
}

interface OutputTableViewDependencies {
  dom: DomElements;
  getNodeTestController: () => NodeTestController | null;
  getRegionController: () => RegionControllerView;
  getColumnVisibility: () => Record<string, boolean>;
  applyColumnWidths: () => void;
  getFilteredOutputEntries: () => CategorizedOutput[];
  getProtocolLabel: (protocol: CategorizedOutput["protocol"]) => string;
  formatSpeed: (mbps: number) => string;
  detectionIps: (
    result: NodeTestResponse | undefined,
    kind: "entry" | "exit",
  ) => string[];
  renderOutputFilter: () => void;
}

export function createOutputTableView({
  dom,
  getNodeTestController,
  getRegionController,
  getColumnVisibility,
  applyColumnWidths,
  getFilteredOutputEntries,
  getProtocolLabel,
  formatSpeed,
  detectionIps,
  renderOutputFilter,
}: OutputTableViewDependencies) {
  let renderedOutputColumns: OutputTableColumn[] = [];
  let renderedOutputColumnSignature = "";
  let renderedOutputRowRange = { start: -1, end: -1 };
  let outputTableRowsFrame: number | null = null;
  let outputTableLastScrollTop = 0;
  let outputFilterRenderFrame: number | null = null;

  function textCell(
    text: string,
    className = "",
    title?: string,
  ): HTMLTableCellElement {
    const cell = document.createElement("td");
    cell.className = className;
    cell.textContent = text;
    if (title) cell.title = title;
    return cell;
  }

  function testCellState(
    entryId: string,
    kind: NodeTestKind,
  ): {
    state: string;
    title: string;
    result?: NonNullable<ReturnType<NodeTestController["getResult"]>>["result"];
  } {
    const value = getNodeTestController()?.getResult(entryId, kind);
    if (!value) return { state: "idle", title: "尚未测试" };
    if (value.state === "running")
      return { state: "running", title: `${kind} 测试中` };
    if (value.state === "error")
      return { state: "error", title: value.error ?? "测试失败" };
    if (value.state === "unavailable")
      return { state: "unavailable", title: value.error ?? "不具备该项测试条件" };
    const result = value.result;
    if (!result?.success)
      return { state: "error", title: result?.error ?? "测试失败", result };
    return { state: "done", title: "", result };
  }

  type RGBColor = readonly [number, number, number];
  type ColorStop = readonly [number, RGBColor];

  // 延迟热力图沿用 NekoSpeed 的颜色锚点，位置按 2000ms 归一化。
  const LATENCY_COLOR_STOPS: readonly ColorStop[] = [
    [0, [0x7b, 0xd8, 0x8f]],
    [0.3, [0xc2, 0xcf, 0x5c]],
    [0.6, [0xf0, 0xa0, 0x4b]],
    [1, [0xe0, 0x60, 0x60]],
  ];

  // 平均速度和峰值速度共用绿、青、蓝渐变。
  const SPEED_COLOR_STOPS: readonly ColorStop[] = [
    [0, [0x7b, 0xd8, 0x8f]],
    [0.5, [0x46, 0xc7, 0xc7]],
    [1, [0x5b, 0x8d, 0xef]],
  ];

  // 为失败、零速和无结果保留不同底色，避免把未测误显示成失败。
  const TABLE_CELL_COLORS = {
    failure: [0xe0, 0x60, 0x60] as const,
    zeroSpeed: [0x9e, 0x9e, 0x9e] as const,
    neutral: [0xa0, 0xa0, 0xa0] as const,
  };

  // 在相邻颜色锚点间线性插值，超出范围时使用首尾锚点颜色。
  function interpolateTableColor(
    stops: readonly ColorStop[],
    progress: number,
  ): RGBColor {
    const value = Math.max(0, Math.min(1, progress));
    if (value <= stops[0][0]) return stops[0][1];

    for (let index = 1; index < stops.length; index += 1) {
      const [end, endColor] = stops[index];
      if (value <= end) {
        const [start, startColor] = stops[index - 1];
        const ratio = (value - start) / (end - start);
        return [
          Math.trunc(startColor[0] + (endColor[0] - startColor[0]) * ratio),
          Math.trunc(startColor[1] + (endColor[1] - startColor[1]) * ratio),
          Math.trunc(startColor[2] + (endColor[2] - startColor[2]) * ratio),
        ];
      }
    }

    return stops[stops.length - 1][1];
  }

  // 按单元格底色亮度切换深色或白色文字，保证色块上的文字可读。
  function setTableCellColor(cell: HTMLTableCellElement, color: RGBColor) {
    const [red, green, blue] = color;
    const luminance = 0.299 * red + 0.587 * green + 0.114 * blue;
    cell.style.backgroundColor = `rgb(${red}, ${green}, ${blue})`;
    cell.style.color = luminance > 130 ? "#1a1a1a" : "#ffffff";
  }

  function latencyCellColor(milliseconds: number): RGBColor {
    // 对齐 NekoSpeed：0~2000ms 映射为绿、黄绿、橙、红渐变。
    return interpolateTableColor(LATENCY_COLOR_STOPS, milliseconds / 2_000);
  }

  function speedCellColor(megabitsPerSecond: number): RGBColor {
    // NekoSpeed 使用字节/秒；本项目以 Mbps 记录，先换算后沿用 1 GiB/s 对数标尺。
    const bytesPerSecond = (Math.max(0, megabitsPerSecond) * 1_000_000) / 8;
    const progress = Math.log1p(bytesPerSecond) / Math.log1p(1 << 30);
    return interpolateTableColor(SPEED_COLOR_STOPS, progress);
  }

  function measureCell(
    entryId: string,
    kind: "tcping" | "url204",
    valueKey: "latencyMs",
  ): HTMLTableCellElement {
    const state = testCellState(entryId, kind);
    const cell = textCell("—", `output-table-result-cell is-${state.state}`);
    if (state.title) cell.title = state.title;
    if (state.state === "running") cell.textContent = "测试中";
    else if (state.state === "error") cell.textContent = "失败";
    else if (state.state === "unavailable") cell.textContent = "不具备条件";
    else if (state.result?.[valueKey] !== undefined) {
      const latency = state.result[valueKey]!;
      cell.textContent = `${latency}ms`;
      cell.title = `${kind === "tcping" ? "TCPing RTT" : "204 URL 延迟"}：${latency}ms${state.result.statusCode ? ` · HTTP ${state.result.statusCode}` : ""}`;
      setTableCellColor(
        cell,
        latency > 0 ? latencyCellColor(latency) : TABLE_CELL_COLORS.failure,
      );
    } else if (state.state === "done") {
      setTableCellColor(cell, TABLE_CELL_COLORS.neutral);
    }
    return cell;
  }

  function speedCell(
    entryId: string,
    valueKey: "downloadMbps" | "downloadMaxMbps",
  ): HTMLTableCellElement {
    const state = testCellState(entryId, "bandwidth");
    const cell = textCell("—", `output-table-result-cell is-${state.state}`);
    if (state.title) cell.title = state.title;
    if (state.state === "running") cell.textContent = "测速中";
    else if (state.state === "error") cell.textContent = "失败";
    else if (state.state === "unavailable") cell.textContent = "不具备条件";
    else if (state.result) {
      const value =
        state.result[valueKey] ??
        (valueKey === "downloadMaxMbps"
          ? state.result.downloadMbps
          : undefined);
      if (value !== undefined) {
        cell.textContent = formatSpeed(value);
        cell.title = `${valueKey === "downloadMbps" ? "平均速度" : "最大速度"}：${formatSpeed(value)}`;
        const hasMeasuredSpeed = (state.result.downloadMbps ?? 0) > 0;
        setTableCellColor(
          cell,
          hasMeasuredSpeed
            ? speedCellColor(value)
            : TABLE_CELL_COLORS.zeroSpeed,
        );
      } else {
        setTableCellColor(cell, TABLE_CELL_COLORS.neutral);
      }
    }
    return cell;
  }

  function speedSamplesCell(entryId: string): HTMLTableCellElement {
    const state = testCellState(entryId, "bandwidth");
    const cell = document.createElement("td");
    cell.className = `output-table-result-cell output-table-spark-cell is-${state.state}`;
    if (state.state === "running") {
      cell.textContent = "测速中";
      return cell;
    }
    if (state.state === "error") {
      cell.textContent = "失败";
      cell.title = state.title;
      return cell;
    }
    if (state.state === "unavailable") {
      cell.textContent = "不具备条件";
      cell.title = state.title;
      return cell;
    }
    const samples = state.result?.downloadSamples ?? [];
    if (!samples.length) {
      cell.textContent = "—";
      cell.title = state.title || "没有逐秒样本";
      return cell;
    }
    const chart = document.createElement("span");
    chart.className = "speed-sparkline";
    chart.setAttribute("role", "img");
    chart.setAttribute("aria-label", "每秒下载速度趋势");
    const peak = Math.max(...samples.map((sample) => sample.mbps), 0.01);
    for (const sample of samples) {
      const bar = document.createElement("i");
      bar.className = "speed-sparkline-bar";
      bar.style.height = `${Math.max(8, (sample.mbps / peak) * 100)}%`;
      chart.append(bar);
    }
    cell.title = samples
      .map((sample) => `${sample.durationMs}ms：${formatSpeed(sample.mbps)}`)
      .join("\n");
    cell.append(chart);
    return cell;
  }

  function isLinkDetectionEnabled(
    kind: "entry" | "exit",
    category: "ip" | "region" | "type",
  ): boolean {
    const settings = getNodeTestController()?.getLinkDetectionSettings();
    if (!settings) return true;
    if (kind === "entry") {
      if (category === "ip") return settings.entryIpEnabled;
      if (category === "region") return settings.entryRegionEnabled;
      return settings.entryTypeEnabled;
    }
    if (category === "ip") return settings.exitIpEnabled;
    if (category === "region") return settings.exitRegionEnabled;
    return settings.exitTypeEnabled;
  }

  function detectionIpCell(
    entry: CategorizedOutput,
    kind: "entry" | "exit",
  ): HTMLTableCellElement {
    if (!isLinkDetectionEnabled(kind, "ip"))
      return textCell("—", "output-table-ip is-left");
    const state = testCellState(entry.id, kind);
    if (state.state === "running")
      return textCell(
        "\u68c0\u6d4b\u4e2d",
        "output-table-ip is-left output-table-result-cell is-running",
        state.title,
      );
    if (state.state === "error")
      return textCell(
        "\u5931\u8d25",
        "output-table-ip is-left output-table-result-cell is-error",
        state.title,
      );
    if (state.state === "unavailable")
      return textCell(
        "\u4e0d\u5177\u5907\u6761\u4ef6",
        "output-table-ip is-left output-table-result-cell is-unavailable",
        state.title,
      );
    const addresses = detectionIps(state.result, kind);
    return textCell(
      addresses.join(", ") ||
        (state.state === "done" ? "\u672a\u77e5" : "\u2014"),
      "output-table-ip is-left",
      addresses.join("\n") || state.title,
    );
  }

  function detectionRegionCell(
    entry: CategorizedOutput,
    kind: "entry" | "exit",
  ): HTMLTableCellElement {
    if (!isLinkDetectionEnabled(kind, "region"))
      return textCell("—", "output-table-text-cell");
    const state = testCellState(entry.id, kind);
    if (state.state === "running")
      return textCell(
        "\u67e5\u8be2\u4e2d",
        "output-table-result-cell is-running",
        state.title,
      );
    if (state.state === "error")
      return textCell(
        "\u5931\u8d25",
        "output-table-result-cell is-error",
        state.title,
      );
    if (state.state === "unavailable")
      return textCell(
        "\u4e0d\u5177\u5907\u6761\u4ef6",
        "output-table-result-cell is-unavailable",
        state.title,
      );

    const addresses = detectionIps(state.result, kind);
    if (state.state !== "done" || addresses.length === 0) {
      return textCell(
        state.state === "done" ? "\u672a\u77e5" : "\u2014",
        "output-table-text-cell",
        state.title,
      );
    }

    const methods = getRegionController().getMethods(kind);
    const ipRegions = addresses.map((address) => {
      const lookup = getRegionController().getIpLookup(kind, address);
      return {
        code: lookup.code,
        priority: lookup.method ? methods.indexOf(lookup.method) : -1,
        pending: lookup.pending,
      };
    });
    const nodeNameCode =
      kind === "entry" && methods.includes("NODE_NAME")
        ? countryCodeFromNodeName(entry.originalName || entry.name)
        : null;
    const nodeNamePriority = methods.indexOf("NODE_NAME");
    const firstIpPriority = ipRegions
      .filter((region) => region.code && region.priority >= 0)
      .reduce<
        number | null
      >((priority, region) => (priority === null ? region.priority : Math.min(priority, region.priority)), null);
    const pending = ipRegions.some((region) => region.pending);
    const firstSelectedIpPriority = methods
      .filter((method) => method !== "NODE_NAME")
      .map((method) => methods.indexOf(method))
      .reduce<number | null>(
        (priority, value) =>
          priority === null ? value : Math.min(priority, value),
        null,
      );
    const nodeNameBeforeIp =
      nodeNamePriority >= 0 &&
      (firstSelectedIpPriority === null ||
        nodeNamePriority < firstSelectedIpPriority);
    const useNodeName =
      Boolean(nodeNameCode) &&
      (nodeNameBeforeIp ||
        (!pending &&
          (firstIpPriority === null || nodeNamePriority < firstIpPriority)));
    const regionNames = useNodeName
      ? [countryNameForCode(nodeNameCode!)]
      : [
          ...new Set(
            ipRegions
              .map((region) => region.code)
              .filter(
                (code): code is string =>
                  Boolean(code) && code !== UNKNOWN_REGION_CODE,
              )
              .map(countryNameForCode),
          ),
        ];
    const label = pending
      ? regionNames.length > 0
        ? `${regionNames.join("\u3001")}（\u67e5\u8be2\u4e2d）`
        : "\u67e5\u8be2\u4e2d"
      : regionNames.join("\u3001") || "\u672a\u77e5";
    const title = useNodeName
      ? `节点名称：${countryNameForCode(nodeNameCode!)}`
      : addresses
          .map((address) => {
            const lookup = getRegionController().getIpLookup(kind, address);
            const region = lookup.pending
              ? "\u67e5\u8be2\u4e2d"
              : lookup.code
                ? countryNameForCode(lookup.code)
                : "\u672a\u77e5";
            return `${address}\uff1a${region}`;
          })
          .join("\n");
    return textCell(label, "output-table-text-cell", title);
  }

  // 当前网段检测只判断 Cloudflare，因此类型列只标记 CF 或非 CF。
  function detectionTypeCell(
    entry: CategorizedOutput,
    kind: "entry" | "exit",
  ): HTMLTableCellElement {
    if (!isLinkDetectionEnabled(kind, "type"))
      return textCell("—", "output-table-result-cell state-idle");
    const state = testCellState(entry.id, kind);
    let label = "\u2014";
    let title = state.title;
    if (state.state === "running") label = "\u68c0\u6d4b\u4e2d";
    else if (state.state === "error") label = "\u5931\u8d25";
    else if (state.state === "unavailable") label = "\u4e0d\u5177\u5907\u6761\u4ef6";
    else if (state.state === "done") {
      const isCloudflare = state.result?.cdnProvider === "Cloudflare";
      label = isCloudflare ? "CF" : "\u975eCF";
      title = isCloudflare
        ? "Cloudflare"
        : "\u672a\u68c0\u6d4b\u5230 Cloudflare";
    }
    return textCell(label, `output-table-result-cell is-${state.state}`, title);
  }

  function unlockResultCell(
    entryId: string,
    serviceId: string,
  ): HTMLTableCellElement {
    const testState = getNodeTestController()?.getResult(entryId, "unlock");
    const cell = document.createElement("td");
    cell.className = "output-table-unlock-cell";
    if (!testState) {
      cell.classList.add("is-idle");
      cell.textContent = "—";
      return cell;
    }
    if (testState.state === "running") {
      cell.classList.add("is-running");
      cell.textContent = "检测中";
      return cell;
    }
    if (testState.state === "unavailable") {
      cell.classList.add("is-unavailable");
      cell.textContent = "不具备条件";
      cell.title = testState.error ?? "不具备该项测试条件";
      return cell;
    }
    if (testState.state === "error" || !testState.result?.success) {
      cell.classList.add("is-request-failed");
      cell.textContent = "请求失败";
      cell.title = testState.error ?? testState.result?.error ?? "解锁检测失败";
      return cell;
    }
    const item = testState.result.unlock?.find(
      (result) => result.id === serviceId,
    );
    if (!item) {
      cell.classList.add("is-unknown");
      cell.textContent = "未测";
      return cell;
    }
    const region = /(?:出口)?地区\s*([A-Z]{2})\b/i
      .exec(item.detail)?.[1]
      ?.toUpperCase();
    // 送中单独使用橄榄黄；warning/partial 为待确认黄；网络请求错误用深红。
    const sentToChina =
      item.state === "senttocn" ||
      (item.state === "blocked" && /(送中|google\.cn)/i.test(item.detail));
    const stateClass =
      item.state === "unlocked"
        ? "is-unlocked"
        : item.state === "partial" || item.state === "warning"
          ? "is-partial"
          : sentToChina
            ? "is-sent-to-cn"
            : item.state === "blocked"
              ? "is-blocked"
              : item.state === "error"
                ? "is-request-failed"
                : "is-unknown";
    const label =
      item.state === "unlocked"
        ? `解锁${region ? `(${region})` : ""}`
        : item.state === "partial"
          ? "部分"
          : item.state === "warning"
            ? "待确认"
            : sentToChina
              ? "送中"
              : item.state === "blocked"
                ? "失败"
                : item.state === "error"
                  ? "请求失败"
                  : "未知";
    cell.classList.add(stateClass);
    cell.textContent = label;
    cell.title = `${item.detail}${item.statusCode ? ` · HTTP ${item.statusCode}` : ""}`;
    return cell;
  }

  function ipRiskCell(entryId: string): HTMLTableCellElement {
    const state = getNodeTestController()?.getResult(entryId, "unlock");
    const item = state?.result?.unlock?.find(
      (result) => result.id === "chatgpt",
    );
    const cell = document.createElement("td");
    cell.className = "output-table-unlock-cell";
    if (state?.state === "running") {
      cell.classList.add("is-running");
      cell.textContent = "检测中";
    } else if (state?.state === "unavailable") {
      cell.classList.add("is-unavailable");
      cell.textContent = "不具备条件";
      cell.title = state.error ?? "不具备该项测试条件";
    } else if (
      state?.state === "error" ||
      (state?.state === "done" && !state.result?.success)
    ) {
      cell.classList.add("is-request-failed");
      cell.textContent = "请求失败";
      cell.title = state.error ?? state.result?.error ?? "IP 风险检测失败";
    } else if (item?.ipRisk === "high") {
      cell.classList.add("is-blocked");
      cell.textContent = "高风险";
      cell.title = item.detail;
    } else if (item?.ipRisk === "low") {
      cell.classList.add("is-unlocked");
      cell.textContent = "低风险";
      cell.title = "OpenAI IP 接口未将出口识别为 VPN 或代理";
    } else {
      cell.classList.add(state ? "is-unknown" : "is-idle");
      cell.textContent = state ? "未知" : "未检测";
      cell.title = item?.detail ?? "随 ChatGPT 解锁检测获取 IP 风险结果";
    }
    return cell;
  }

  function makeColumn(
    key: string,
    label: string,
    width: number,
    renderCell: OutputTableColumn["renderCell"],
    className = "",
    renderFooter?: OutputTableColumn["renderFooter"],
  ): OutputTableColumn {
    return { key, label, width, className, renderCell, renderFooter };
  }

  function outputTableColumns(): OutputTableColumn[] {
    const common: OutputTableColumn[] = [
      makeColumn(
        "index",
        "序号",
        OUTPUT_COLUMN_DEFAULT_WIDTHS.index,
        (_entry, index) => textCell(`${index + 1}`, "output-table-index-cell"),
        "is-centered",
      ),
      makeColumn(
        "name",
        "节点名称",
        OUTPUT_COLUMN_DEFAULT_WIDTHS.name,
        (entry) => {
          const cell = document.createElement("td");
          const name = document.createElement("strong");
          name.className = "output-table-primary output-table-truncate";
          name.textContent = entry.name.trim() || "未命名节点";
          name.title = name.textContent;
          cell.append(name);
          return cell;
        },
      ),
      makeColumn(
        "protocol",
        "类型",
        OUTPUT_COLUMN_DEFAULT_WIDTHS.protocol,
        (entry) =>
          textCell(
            getProtocolLabel(entry.protocol),
            "output-table-protocol-cell",
          ),
        "is-centered",
      ),
      makeColumn(
        "conversionStatus",
        "转换状态",
        OUTPUT_COLUMN_DEFAULT_WIDTHS.conversionStatus,
        (entry) => {
          const labels = {
            complete: "完整",
            lossy: "有损",
            invalid: "配置无效",
            unsupported: "暂不支持编码",
          } as const;
          const diagnosticDetails = entry.conversionDiagnostics
            .map((item) => `${item.field ? `${item.field}：` : ""}${item.message}`)
          const details = diagnosticDetails.slice(0, 8);
          if (diagnosticDetails.length > details.length)
            details.push(`另有 ${diagnosticDetails.length - details.length} 条诊断，请查看转换日志`);
          const title = [
            `${labels[entry.conversionStatus]} · ${entry.uri ? "可导出 URI" : "无可导出 URI"}`,
            ...details,
          ].join("\n");
          return textCell(
            labels[entry.conversionStatus],
            `output-table-conversion-status is-${entry.conversionStatus}`,
            title,
          );
        },
        "is-centered",
        (entries) => {
          const count = (status: CategorizedOutput["conversionStatus"]) =>
            entries.filter((entry) => entry.conversionStatus === status).length;
          return textCell(
            `完整 ${count("complete")} · 有损 ${count("lossy")} · 不可转换 ${count("invalid") + count("unsupported")}`,
            "output-table-summary-cell",
            `可导出 URI ${entries.filter((entry) => entry.uri).length} 条`,
          );
        },
      ),
    ];

    const measurements = [
      makeColumn(
        "rtt",
        "TCPing 延迟",
        OUTPUT_COLUMN_DEFAULT_WIDTHS.rtt,
        (entry) => measureCell(entry.id, "tcping", "latencyMs"),
        "is-centered",
      ),
      makeColumn(
        "http",
        "204 URL 延迟",
        OUTPUT_COLUMN_DEFAULT_WIDTHS.http,
        (entry) => measureCell(entry.id, "url204", "latencyMs"),
        "is-centered",
      ),
    ];

    const services = getNodeTestController()?.getUnlockServices() ?? [];
    const leadingServiceIds = [
      "netflix",
      "youtube",
      "disney",
      "tiktok",
      "chatgpt",
      "gemini",
      "claude",
    ];
    const leadingServices = leadingServiceIds
      .map((id) => services.find((service) => service.id === id))
      .filter(
        (service): service is UnlockServiceDefinition => service !== undefined,
      );
    const leadingIds = new Set(leadingServices.map((service) => service.id));
    const additionalServices = services.filter(
      (service) => !leadingIds.has(service.id),
    );
    return [
      ...common,
      makeColumn(
        "server",
        "地址",
        OUTPUT_COLUMN_DEFAULT_WIDTHS.server,
        (entry) => textCell(entry.server || "—", "output-table-ip"),
        "is-left",
      ),
      makeColumn(
        "port",
        "端口",
        OUTPUT_COLUMN_DEFAULT_WIDTHS.port,
        (entry) => textCell(`${entry.port}`, "output-table-port"),
        "is-centered",
      ),
      makeColumn(
        "entryIp",
        "入口IP",
        OUTPUT_COLUMN_DEFAULT_WIDTHS.entryIp,
        (entry) => detectionIpCell(entry, "entry"),
        "is-left",
      ),
      makeColumn(
        "entryRegion",
        "入口地区",
        OUTPUT_COLUMN_DEFAULT_WIDTHS.entryRegion,
        (entry) => detectionRegionCell(entry, "entry"),
        "is-centered",
      ),
      makeColumn(
        "entryType",
        "入口类型",
        OUTPUT_COLUMN_DEFAULT_WIDTHS.entryType,
        (entry) => detectionTypeCell(entry, "entry"),
        "is-centered",
      ),
      makeColumn(
        "exitIp",
        "出口IP",
        OUTPUT_COLUMN_DEFAULT_WIDTHS.exitIp,
        (entry) => detectionIpCell(entry, "exit"),
        "is-left",
      ),
      makeColumn(
        "exitRegion",
        "出口地区",
        OUTPUT_COLUMN_DEFAULT_WIDTHS.exitRegion,
        (entry) => detectionRegionCell(entry, "exit"),
        "is-centered",
      ),
      makeColumn(
        "exitType",
        "出口类型",
        OUTPUT_COLUMN_DEFAULT_WIDTHS.exitType,
        (entry) => detectionTypeCell(entry, "exit"),
        "is-centered",
      ),
      ...measurements,
      makeColumn(
        "average",
        "平均速度",
        OUTPUT_COLUMN_DEFAULT_WIDTHS.average,
        (entry) => speedCell(entry.id, "downloadMbps"),
        "is-centered",
      ),
      makeColumn(
        "peak",
        "最大速度",
        OUTPUT_COLUMN_DEFAULT_WIDTHS.peak,
        (entry) => speedCell(entry.id, "downloadMaxMbps"),
        "is-centered",
      ),
      makeColumn(
        "perSecond",
        "每秒速度",
        OUTPUT_COLUMN_DEFAULT_WIDTHS.perSecond,
        (entry) => speedSamplesCell(entry.id),
        "is-centered",
      ),
      makeColumn(
        "ipRisk",
        "IP 风险",
        OUTPUT_COLUMN_DEFAULT_WIDTHS.ipRisk,
        (entry) => ipRiskCell(entry.id),
        "is-centered",
        (entries) => ipRiskSummaryCell(entries),
      ),
      ...leadingServices.map((service) => serviceColumn(service)),
      ...additionalServices.map((service) => serviceColumn(service)),
    ];
  }

  function ipRiskSummaryCell(
    entries: CategorizedOutput[],
  ): HTMLTableCellElement {
    const risks = entries
      .map((entry) => getNodeTestController()?.getResult(entry.id, "unlock"))
      .filter(
        (
          state,
        ): state is NonNullable<ReturnType<NodeTestController["getResult"]>> =>
          state?.state === "done" && state.result?.success === true,
      )
      .map(
        (state) =>
          state.result?.unlock?.find((item) => item.id === "chatgpt")?.ipRisk,
      )
      .filter(
        (risk): risk is "low" | "high" => risk === "low" || risk === "high",
      );
    if (!risks.length) return textCell("—", "output-table-summary-cell");
    const lowRisk = risks.filter((risk) => risk === "low").length;
    const percent = Math.round((lowRisk / risks.length) * 100);
    return textCell(
      `${percent}%`,
      "output-table-summary-cell is-summary-unlocked",
      `${lowRisk}/${risks.length} 个节点为低风险`,
    );
  }

  function serviceColumn(service: UnlockServiceDefinition): OutputTableColumn {
    // 表头按参考图缩短，完整检测名称仍保留在设置项与提示中。
    const displayNames: Record<string, string> = {
      youtube: "YouTube",
      chatgpt: "OpenAI",
      gemini: "Gemini",
    };
    const label = displayNames[service.id] ?? service.name;
    const width = Math.max(104, Math.min(160, label.length * 9 + 24));
    return {
      ...makeColumn(
        `service:${service.id}`,
        label,
        width,
        (entry) => unlockResultCell(entry.id, service.id),
        "is-centered",
        (entries) => {
          const tested = entries
            .map((entry) =>
              getNodeTestController()?.getResult(entry.id, "unlock"),
            )
            .filter(
              (
                state,
              ): state is NonNullable<
                ReturnType<NodeTestController["getResult"]>
              > => state?.state === "done" && state.result?.success === true,
            )
            .map((state) =>
              state.result?.unlock?.find((item) => item.id === service.id),
            )
            .filter(
              (item): item is NonNullable<typeof item> => item !== undefined,
            );
          if (!tested.length) return textCell("—", "output-table-summary-cell");
          const unlocked = tested.filter(
            (item) => item.state === "unlocked",
          ).length;
          const percent = Math.round((unlocked / tested.length) * 100);
          return textCell(
            `${percent}%`,
            "output-table-summary-cell is-summary-unlocked",
            `${unlocked}/${tested.length} 个节点支持 ${service.name}`,
          );
        },
      ),
      settingsLabel: service.name,
    };
  }

  function renderOutputTableHeader(): boolean {
    const columns = outputTableColumns().filter(
      (column) =>
        column.key === "conversionStatus" ||
        getColumnVisibility()[column.key] !== false,
    );
    const signature = JSON.stringify(
      columns.map(({ key, label, width }) => [key, label, width]),
    );
    if (signature === renderedOutputColumnSignature) return false;

    renderedOutputColumns = columns;
    renderedOutputColumnSignature = signature;

    const colElements = renderedOutputColumns.map((column) => {
      const col = document.createElement("col");
      col.dataset.columnKey = column.key;
      col.dataset.defaultWidth = `${column.width}`;
      return col;
    });
    const fillerCol = document.createElement("col");
    fillerCol.className = "output-table-filler";
    dom.outputTableColumns.replaceChildren(...colElements, fillerCol);

    const headerRow = document.createElement("tr");
    for (const column of renderedOutputColumns) {
      const header = document.createElement("th");
      header.scope = "col";
      header.className = column.className ?? "";
      header.textContent = column.label;
      const handle = document.createElement("span");
      handle.className = "output-column-resizer";
      handle.dataset.columnKey = column.key;
      handle.dataset.defaultWidth = `${column.width}`;
      handle.setAttribute("role", "separator");
      handle.setAttribute("aria-orientation", "vertical");
      handle.setAttribute("aria-label", `调整${column.label}列宽`);
      handle.tabIndex = 0;
      header.append(handle);
      headerRow.append(header);
    }
    const fillerHeader = document.createElement("th");
    fillerHeader.className = "output-table-filler";
    fillerHeader.setAttribute("aria-hidden", "true");
    headerRow.append(fillerHeader);
    dom.outputTableHead.replaceChildren(headerRow);

    applyColumnWidths();
    return true;
  }

  function renderOutputTableFooter(entries: CategorizedOutput[]) {
    const hasTestSummary = entries.some(
      (entry) =>
        getNodeTestController()?.getResult(entry.id, "unlock")?.state ===
        "done",
    );
    if (entries.length === 0) {
      dom.outputTableFoot.replaceChildren();
    } else {
      const summaryRow = document.createElement("tr");
      for (const column of renderedOutputColumns) {
        let cell: HTMLTableCellElement;
        if (column.key === "name")
          cell = textCell(hasTestSummary ? "节点统计 / 解锁率" : "节点统计", "output-table-summary-label");
        else if (column.renderFooter) cell = column.renderFooter(entries);
        else cell = textCell("", "output-table-summary-empty");
        summaryRow.append(cell);
      }
      const filler = document.createElement("td");
      filler.className = "output-table-filler";
      filler.setAttribute("aria-hidden", "true");
      summaryRow.append(filler);
      dom.outputTableFoot.replaceChildren(summaryRow);
    }
  }

  function renderOutputTableRow(
    entry: CategorizedOutput,
    index: number,
  ): HTMLTableRowElement {
    const row = document.createElement("tr");
    row.dataset.nodeId = entry.id;
    row.append(
      ...renderedOutputColumns.map((column) => column.renderCell(entry, index)),
    );
    const fillerCell = document.createElement("td");
    fillerCell.className = "output-table-filler";
    fillerCell.setAttribute("aria-hidden", "true");
    row.append(fillerCell);
    return row;
  }

  function createOutputTableSpacer(height: number): HTMLTableRowElement {
    const row = document.createElement("tr");
    row.className = "output-table-virtual-spacer";
    row.setAttribute("aria-hidden", "true");
    row.style.height = `${height}px`;
    const cell = document.createElement("td");
    cell.colSpan = renderedOutputColumns.length + 1;
    cell.style.height = `${height}px`;
    cell.style.padding = "0";
    cell.style.border = "0";
    cell.style.lineHeight = "0";
    cell.style.fontSize = "0";
    row.append(cell);
    return row;
  }

  function renderOutputTableRows(force = false) {
    const entries = getFilteredOutputEntries();
    const rowHeight =
      dom.outputTableBody
        .querySelector<HTMLTableRowElement>("tr[data-node-id]")
        ?.getBoundingClientRect().height || OUTPUT_TABLE_ROW_HEIGHT_ESTIMATE;
    const headerHeight =
      dom.outputTableHead.rows[0]?.getBoundingClientRect().height ||
      OUTPUT_TABLE_ROW_HEIGHT_ESTIMATE;
    const virtualized = entries.length > OUTPUT_TABLE_VIRTUALIZATION_THRESHOLD;
    const footerHeight =
      dom.outputTableFoot.rows[0]?.getBoundingClientRect().height || 0;
    const maxScrollTop = Math.max(
      0,
      headerHeight +
        entries.length * rowHeight +
        footerHeight -
        dom.outputTableWrap.clientHeight,
    );
    if (dom.outputTableWrap.scrollTop > maxScrollTop)
      dom.outputTableWrap.scrollTop = maxScrollTop;
    const bodyScrollTop = Math.max(
      0,
      dom.outputTableWrap.scrollTop - headerHeight,
    );
    const firstVisible = Math.floor(bodyScrollTop / rowHeight);
    const lastVisible = Math.ceil(
      (bodyScrollTop + dom.outputTableWrap.clientHeight) / rowHeight,
    );
    const start =
      virtualized && entries.length > 0
        ? Math.min(
            entries.length - 1,
            Math.max(0, firstVisible - OUTPUT_TABLE_OVERSCAN_ROWS),
          )
        : 0;
    const end = virtualized
      ? Math.min(
          entries.length,
          Math.max(start + 1, lastVisible + OUTPUT_TABLE_OVERSCAN_ROWS),
        )
      : entries.length;

    if (
      !force &&
      start === renderedOutputRowRange.start &&
      end === renderedOutputRowRange.end
    )
      return;

    const fragment = document.createDocumentFragment();
    if (start > 0) fragment.append(createOutputTableSpacer(start * rowHeight));
    for (let index = start; index < end; index++) {
      fragment.append(renderOutputTableRow(entries[index]!, index));
    }
    if (end < entries.length)
      fragment.append(
        createOutputTableSpacer((entries.length - end) * rowHeight),
      );
    dom.outputTableBody.replaceChildren(fragment);
    renderedOutputRowRange = { start, end };
  }

  function scheduleOutputTableRows() {
    if (outputTableRowsFrame !== null) return;
    outputTableRowsFrame = requestAnimationFrame(() => {
      outputTableRowsFrame = null;
      renderOutputTableRows();
    });
  }

  function handleOutputTableScroll() {
    const scrollTop = dom.outputTableWrap.scrollTop;
    if (scrollTop === outputTableLastScrollTop) return;
    outputTableLastScrollTop = scrollTop;
    scheduleOutputTableRows();
  }

  function scheduleOutputFilterRender() {
    if (outputFilterRenderFrame !== null) return;
    outputFilterRenderFrame = requestAnimationFrame(() => {
      outputFilterRenderFrame = null;
      renderOutputFilter();
    });
  }

  function captureOutputTableSnapshotForExport() {
    if (outputFilterRenderFrame !== null) {
      cancelAnimationFrame(outputFilterRenderFrame);
      outputFilterRenderFrame = null;
      renderOutputFilter();
    }
    const entries = getFilteredOutputEntries();
    if (entries.length <= OUTPUT_TABLE_VIRTUALIZATION_THRESHOLD)
      return captureOutputTableSnapshot(dom.outputTable);

    const wrapper = document.createElement("div");
    wrapper.className = "output-table-wrap output-table-export-staging";
    wrapper.setAttribute("aria-hidden", "true");
    wrapper.style.position = "fixed";
    wrapper.style.left = "-100000px";
    wrapper.style.top = "0";
    wrapper.style.visibility = "hidden";
    wrapper.style.pointerEvents = "none";
    wrapper.style.width = `${Math.max(dom.outputTableWrap.clientWidth, dom.outputTable.scrollWidth)}px`;
    wrapper.style.height = `${Math.max(dom.outputTableWrap.clientHeight, (entries.length + 2) * OUTPUT_TABLE_ROW_HEIGHT_ESTIMATE + 60)}px`;
    wrapper.style.overflow = "visible";

    const table = dom.outputTable.cloneNode(true) as HTMLTableElement;
    const body = table.tBodies[0];
    if (!body) return null;
    const rows = document.createDocumentFragment();
    entries.forEach((entry, index) =>
      rows.append(renderOutputTableRow(entry, index)),
    );
    body.replaceChildren(rows);
    wrapper.append(table);
    document.body.append(wrapper);
    try {
      return captureOutputTableSnapshot(table);
    } finally {
      wrapper.remove();
    }
  }
  return {
    getOutputTableColumns: outputTableColumns,
    getRenderedOutputColumns: () => renderedOutputColumns,
    renderOutputTableHeader,
    renderOutputTableFooter,
    renderOutputTableRows,
    renderOutputTableRow,
    scheduleOutputTableRows,
    handleOutputTableScroll,
    scheduleOutputFilterRender,
    captureOutputTableSnapshotForExport,
  };
}
