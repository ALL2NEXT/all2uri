import { diagnostic } from "../core/diagnostics/index.ts";
import { convertSourcesInWorker } from "../core/worker-client.ts";
import type { Diagnostic } from "../core/diagnostics/index.ts";
import type { ConversionResult, SourceDocument } from "../core/pipeline.ts";
import type { NodeTestController } from "../node-test.ts";
import type {
  CategorizedOutput,
  FetchConcurrencyMode,
  FetchConcurrencySetting,
  SourceResult,
} from "./types.ts";
import type { DetectedImportInput } from "./import-controller.ts";
import type { DomElements } from "./dom.ts";
import { ConversionError, failureFrom } from "./errors.ts";
import { MAX_BATCH_INPUT_BYTES } from "./limits.ts";
import {
  DEFAULT_REMOTE_TIMEOUT_SECONDS,
  MIN_FETCH_CONCURRENCY,
  MIN_REMOTE_BATCH_BYTES,
  MIN_REMOTE_TIMEOUT_SECONDS,
  USER_AGENT_PRESETS,
  type FetchedSubscription,
} from "./subscription-fetcher.ts";

interface ConversionControllerDependencies {
  dom: DomElements;
  readImportInput: () => DetectedImportInput | null;
  runWithConcurrency: <T>(
    items: T[],
    concurrency: number,
    worker: (item: T, index: number) => Promise<void>,
  ) => Promise<void>;
  fetchSubscriptionWithFallback: (
    url: string,
    userAgent: string | null,
    maxRedirects: number,
    timeoutSeconds: number,
    sourceId: string,
    requestId: string,
    signal: AbortSignal,
  ) => Promise<FetchedSubscription>;
  cancelActiveRequests: () => void;
  shouldIncludeLossyOutput: () => boolean;
  setOutputEntries: (entries: CategorizedOutput[]) => void;
  getOutputUris: () => string[];
  setOutputUris: (uris: string[]) => void;
  getNodeTestController: () => NodeTestController | null;
  resetRegionLookupState: () => void;
  renderOutputFilter: () => void;
  enrichOutputRegions: () => void | Promise<void>;
  setBusy: (busy: boolean) => void;
  setValidation: (message?: string) => void;
  showToast: (message: string, isError?: boolean) => void;
  appendLog: (message: string, isError?: boolean) => void;
  setProcessingStatus: (
    label: string,
    state: "idle" | "running" | "done" | "warning" | "error",
  ) => void;
  updateProgress: (done: number, total: number) => void;
  displayUrl: (url: string) => string;
}

export function createConversionController({
  dom,
  readImportInput,
  runWithConcurrency,
  fetchSubscriptionWithFallback,
  cancelActiveRequests,
  shouldIncludeLossyOutput,
  setOutputEntries,
  getOutputUris,
  setOutputUris,
  getNodeTestController,
  resetRegionLookupState,
  renderOutputFilter,
  enrichOutputRegions,
  setBusy,
  setValidation,
  showToast,
  appendLog,
  setProcessingStatus,
  updateProgress,
  displayUrl,
}: ConversionControllerDependencies) {
  let sourceResults: SourceResult[] = [];
  let activeSourceDocuments: SourceDocument[] = [];
  let conversionAbort: AbortController | null = null;
  let cancelRequested = false;
  let running = false;
  let completedSources = 0;
  let fetchRunId = 0;

  function formatBytes(bytes = 0): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  }

  function resolveUserAgent(): string | null {
    const preset = dom.userAgentSelect.value;
    if (preset === "auto") return null;
    if (preset === "custom") {
      const custom = dom.customUserAgent.value.trim();
      if (!custom) {
        setValidation("已选择自定义 User-Agent，但输入内容为空。");
        dom.customUserAgent.focus();
        throw new ConversionError(
          "invalid_user_agent",
          "自定义 User-Agent 不能为空。",
        );
      }
      if (/[\r\n]/.test(custom)) {
        setValidation("User-Agent 不能包含换行。");
        dom.customUserAgent.focus();
        throw new ConversionError(
          "invalid_user_agent",
          "User-Agent 格式无效。",
        );
      }
      return custom;
    }
    return USER_AGENT_PRESETS[preset] ?? null;
  }

  function resolveMaxRedirects(): number {
    const maxRedirects = dom.maxRedirects.valueAsNumber;
    if (!Number.isInteger(maxRedirects) || maxRedirects < 0) {
      setValidation("最大重定向次数必须是大于等于 0 的整数。");
      dom.maxRedirects.focus();
      throw new ConversionError("invalid_redirect_limit", "重定向设置无效。");
    }
    return maxRedirects;
  }

  function resolveRemoteTimeoutSeconds(): number {
    const timeoutSeconds = dom.remoteTimeoutSeconds.valueAsNumber;
    if (
      !Number.isInteger(timeoutSeconds) ||
      timeoutSeconds < MIN_REMOTE_TIMEOUT_SECONDS
    ) {
      setValidation(
        `远程订阅超时必须是大于等于 ${MIN_REMOTE_TIMEOUT_SECONDS} 秒的整数。`,
      );
      dom.remoteTimeoutSeconds.focus();
      throw new ConversionError("invalid_timeout", "远程订阅超时设置无效。");
    }
    return timeoutSeconds;
  }

  function resolveFetchConcurrencySetting(): FetchConcurrencySetting {
    const mode: FetchConcurrencyMode =
      dom.fetchConcurrencyMode.value === "percent" ? "percent" : "fixed";
    const value = dom.fetchConcurrency.valueAsNumber;
    if (!Number.isInteger(value) || value < MIN_FETCH_CONCURRENCY) {
      setValidation(`并发数值必须是大于等于 ${MIN_FETCH_CONCURRENCY} 的整数。`);
      dom.fetchConcurrency.focus();
      throw new ConversionError("invalid_concurrency", "并发设置无效。");
    }
    return { mode, value };
  }

  function resolveFetchConcurrency(
    setting: FetchConcurrencySetting,
    totalRequests: number,
  ): number {
    if (setting.mode === "fixed")
      return Math.min(setting.value, Math.max(1, totalRequests));
    const requested = Math.max(
      1,
      Math.ceil((totalRequests * setting.value) / 100),
    );
    return Math.min(requested, Math.max(1, totalRequests));
  }

  function describeFetchConcurrency(
    setting: FetchConcurrencySetting,
    totalRequests: number,
    effective: number,
  ): string {
    if (setting.mode === "percent") {
      return `${setting.value}% × ${totalRequests} 个远程请求，实际并发 ${effective} 个`;
    }
    return `固定 ${setting.value} 个，本次实际并发 ${effective} 个`;
  }

  function appendConversionDiagnostics(result: ConversionResult) {
    const labels = new Map(
      sourceResults.map((source) => [
        source.kind === "local" ? "local" : source.sourceId,
        source.kind === "local" ? "本地内容" : displayUrl(source.url),
      ]),
    );
    const visible = result.diagnostics.slice(0, 40);
    for (const item of visible) {
      const sourceLabel = labels.get(item.sourceId) ?? item.sourceId;
      const location = [item.location, item.nodeId ? `节点 ${item.nodeId}` : ""]
        .filter(Boolean)
        .join(" · ");
      const field = item.field ? ` 字段 ${item.field}` : "";
      appendLog(
        `${sourceLabel} · ${item.stage}/${item.code}${location ? ` · ${location}` : ""}${field}：${item.message}`,
        item.severity === "error",
      );
    }
    if (result.diagnostics.length > visible.length) {
      appendLog(
        `另有 ${result.diagnostics.length - visible.length} 条诊断，已在转换结果中统计。`,
      );
    }
  }

  function aggregateResults(result: ConversionResult, logDiagnostics = true) {
    getNodeTestController()?.clearResults();
    const outputEntries = result.encoded
      .filter(
        (item) =>
          item.uri &&
          (item.status === "complete" ||
            (shouldIncludeLossyOutput() && item.status === "lossy")),
      )
      .map((item, index) => ({
        id: `${item.node.id}-${index}`,
        name: item.node.name,
        originalName: item.node.name,
        server: item.node.server,
        port: item.node.port,
        protocol: item.node.protocol,
        uri: item.uri!,
        countryCode: null,
        node: item.node,
      }));
    setOutputEntries(outputEntries);
    const outputUris = outputEntries.map((item) => item.uri);
    setOutputUris(outputUris);
    const allowed = new Set(outputUris);

    for (const source of sourceResults) {
      const sourceId = source.kind === "local" ? "local" : source.sourceId;
      source.diagnostics = result.diagnostics.filter(
        (item) => item.sourceId === sourceId,
      );
      const sourceEncodings = result.encoded.filter((item) =>
        item.node.sources.some((origin) => origin.sourceId === sourceId),
      );
      source.nodes = sourceEncodings
        .filter((item) => item.uri && allowed.has(item.uri))
        .map((item) => item.uri as string);
      if (source.content !== undefined) {
        if (source.nodes.length > 0) source.state = "success";
        else {
          source.state = "error";
          const hasLossyOnlyResults =
            !shouldIncludeLossyOutput() &&
            sourceEncodings.some((item) => item.status === "lossy");
          source.errorCode = hasLossyOnlyResults ? "lossy_only" : "no_nodes";
          source.errorMessage = hasLossyOnlyResults
            ? "节点包含无法无损转换的字段；可在输出设置中允许有损结果。"
            : "来源内容没有生成可用 URI，请查看解析与验证诊断。";
        }
      }
    }

    renderOutputFilter();
    if (logDiagnostics) appendConversionDiagnostics(result);
    void enrichOutputRegions();
  }

  async function refreshConversion() {
    if (!activeSourceDocuments.length || running) return;
    const controller = new AbortController();
    conversionAbort = controller;
    running = true;
    setBusy(true);
    try {
      const result = await convertSourcesInWorker(activeSourceDocuments, {
        deduplicate: false,
        includeLossy: shouldIncludeLossyOutput(),
        signal: controller.signal,
      });
      aggregateResults(result, false);
    } catch (error) {
      appendLog(`重新转换失败：${failureFrom(error).message}`, true);
    } finally {
      if (conversionAbort === controller) conversionAbort = null;
      running = false;
      setBusy(false);
    }
  }

  function refreshForConversionSettingChange() {
    if (!running && activeSourceDocuments.length > 0) void refreshConversion();
  }

  function cancelConversion() {
    if (!running) return;
    cancelRequested = true;
    conversionAbort?.abort();
    cancelActiveRequests();
    dom.convertButton.disabled = true;
    dom.convertLabel.textContent = "正在取消…";
    appendLog("正在取消后续处理…");
  }

  async function startConversion() {
    if (running) return;

    const input = readImportInput();
    if (!input) return;
    const remoteUrls = dom.remoteSubscriptionFetchEnabled.checked
      ? input.urls
      : [];
    const skippedRemoteCount = input.urls.length - remoteUrls.length;

    if (input.local.length === 0 && remoteUrls.length === 0) {
      dom.logList.replaceChildren();
      appendLog(`远程订阅拉取已关闭，跳过 ${skippedRemoteCount} 个远程地址。`);
      showToast("远程订阅拉取已关闭，没有可转换的本地内容", true);
      return;
    }

    let userAgent: string | null = null;
    let fetchConcurrency = MIN_FETCH_CONCURRENCY;
    let fetchConcurrencySetting: FetchConcurrencySetting | null = null;
    let maxRedirects = 0;
    let remoteTimeoutSeconds = DEFAULT_REMOTE_TIMEOUT_SECONDS;
    if (remoteUrls.length > 0) {
      try {
        userAgent = resolveUserAgent();
        fetchConcurrencySetting = resolveFetchConcurrencySetting();
        fetchConcurrency = resolveFetchConcurrency(
          fetchConcurrencySetting,
          remoteUrls.length,
        );
        maxRedirects = resolveMaxRedirects();
        remoteTimeoutSeconds = resolveRemoteTimeoutSeconds();
      } catch (error) {
        showToast(failureFrom(error).message, true);
        return;
      }
    }

    cancelRequested = false;
    activeSourceDocuments = [];
    const runController = new AbortController();
    conversionAbort = runController;
    fetchRunId++;

    // 本地内容与每个远程订阅分别保留来源 ID，统一进入转换管线。
    const hasLocal = input.local.length > 0;
    const localContent = hasLocal ? input.local.join("\n") : undefined;
    const localBytes = hasLocal ? new Blob([input.local.join("\n")]).size : 0;
    let accumulatedContentBytes = localBytes;
    const localInputDiagnostics: Diagnostic[] = [];
    if (hasLocal && input.fragmentsTruncated) {
      localInputDiagnostics.push(
        diagnostic(
          { sourceId: "local", stage: "preprocess" },
          "fragment_limit",
          "warning",
          "Input expansion stopped at the configured fragment limit.",
        ),
      );
    }
    if (hasLocal && input.uriLimitReached) {
      localInputDiagnostics.push(
        diagnostic(
          { sourceId: "local", stage: "preprocess" },
          "uri_limit",
          "warning",
          "URI extraction stopped at the 100,000 node limit.",
        ),
      );
    }
    if (hasLocal && input.decodedTooLarge > 0) {
      localInputDiagnostics.push(
        diagnostic(
          { sourceId: "local", stage: "preprocess" },
          "decoded_fragment_too_large",
          "warning",
          `${input.decodedTooLarge} decoded fragment(s) exceeded the 64 MiB limit.`,
        ),
      );
    }
    if (hasLocal && input.depthLimited) {
      localInputDiagnostics.push(
        diagnostic(
          { sourceId: "local", stage: "preprocess" },
          "recursion_limit",
          "warning",
          "Base64 expansion stopped at depth 16.",
        ),
      );
    }
    const remoteOffset = hasLocal ? 1 : 0;
    const totalSources = remoteUrls.length + remoteOffset;
    const remainingBatchBytes = Math.max(0, MAX_BATCH_INPUT_BYTES - localBytes);
    const canFetchRemote =
      remoteUrls.length === 0 || remainingBatchBytes >= MIN_REMOTE_BATCH_BYTES;
    sourceResults = [];
    if (hasLocal) {
      sourceResults.push({
        sourceId: "local",
        kind: "local",
        url: "",
        state: "pending",
        nodes: [],
        diagnostics: localInputDiagnostics,
        content: localContent,
        bytes: localBytes,
      });
    }
    sourceResults.push(
      ...remoteUrls.map((url, index) => ({
        sourceId: `remote-${index + 1}`,
        kind: "remote" as const,
        url,
        state: "pending" as const,
        nodes: [],
        diagnostics: [],
      })),
    );

    dom.logList.replaceChildren();
    appendLog(`开始处理：${totalSources} 个来源`);
    if (skippedRemoteCount > 0) {
      appendLog(`远程订阅拉取已关闭，跳过 ${skippedRemoteCount} 个远程地址。`);
    }
    if (canFetchRemote && remoteUrls.length > 0 && fetchConcurrencySetting) {
      appendLog(
        `远程请求并发：${describeFetchConcurrency(fetchConcurrencySetting, remoteUrls.length, fetchConcurrency)}`,
      );
    }
    if (
      !hasLocal &&
      (input.fragmentsTruncated ||
        input.uriLimitReached ||
        input.decodedTooLarge > 0 ||
        input.depthLimited)
    ) {
      appendLog("输入展开或 URI 提取触及资源上限，部分内容已跳过。", true);
    }
    if (hasLocal) {
      appendLog("本地内容：已加入统一转换队列");
    }
    if (remoteUrls.length > 0 && !canFetchRemote) {
      for (const source of sourceResults.slice(remoteOffset)) {
        source.state = "error";
        source.errorCode = "batch_input_too_large";
        source.errorMessage =
          "Local input leaves less than 1 MiB of the 64 MiB conversion limit.";
      }
      appendLog("本地输入已达到 64 MiB 上限，远程订阅未发起请求。", true);
    }

    setOutputUris([]);
    setOutputEntries([]);
    resetRegionLookupState();
    completedSources = sourceResults.filter(
      (source) => source.state === "error",
    ).length;

    running = true;
    setBusy(true);
    renderOutputFilter();
    updateProgress(completedSources, totalSources);

    await runWithConcurrency(
      canFetchRemote ? remoteUrls : [],
      fetchConcurrency,
      async (url, index) => {
        const sourceIndex = remoteOffset + index;
        const source = sourceResults[sourceIndex];
        appendLog(`远程订阅 ${displayUrl(url)}：开始拉取`);
        try {
          const fetched = await fetchSubscriptionWithFallback(
            url,
            userAgent,
            maxRedirects,
            remoteTimeoutSeconds,
            source.sourceId,
            `${fetchRunId}:${source.sourceId}`,
            runController.signal,
          );
          if (cancelRequested) {
            sourceResults[sourceIndex] = {
              ...source,
              state: "error",
              errorCode: "cancelled",
              errorMessage: "处理已取消。",
            };
          } else if (
            accumulatedContentBytes + fetched.bytes >
            MAX_BATCH_INPUT_BYTES
          ) {
            sourceResults[sourceIndex] = {
              ...source,
              state: "error",
              errorCode: "batch_input_too_large",
              errorMessage:
                "Combined subscription content exceeds the 64 MiB conversion limit.",
            };
            appendLog(
              `远程订阅 ${displayUrl(url)}：内容未加入转换，合并输入超过 64 MiB 上限`,
              true,
            );
          } else {
            accumulatedContentBytes += fetched.bytes;
            sourceResults[sourceIndex] = {
              ...source,
              state: "pending",
              content: fetched.content,
              bytes: fetched.bytes,
              finalUrl: fetched.finalUrl,
              usedUserAgent: fetched.usedUserAgent,
            };
            appendLog(
              `远程订阅 ${displayUrl(url)}：已获取 ${formatBytes(fetched.bytes)}，开始统一解析`,
            );
          }
        } catch (error) {
          const failure = failureFrom(error);
          sourceResults[sourceIndex] = {
            ...source,
            state: "error",
            errorCode: failure.code,
            errorMessage: failure.message,
          };
          appendLog(
            `远程订阅 ${displayUrl(url)}：失败，${failure.message}`,
            true,
          );
        } finally {
          completedSources++;
          updateProgress(completedSources, totalSources);
        }
      },
    );

    for (const source of sourceResults) {
      if (source.state === "pending" && cancelRequested) {
        source.state = "error";
        source.errorCode = "cancelled";
        source.errorMessage = "处理已取消。";
        completedSources++;
      }
    }

    activeSourceDocuments = sourceResults
      .filter(
        (source) => source.content !== undefined && source.state === "pending",
      )
      .map((source) => ({
        sourceId: source.sourceId,
        sourceName:
          source.kind === "local" ? "本地内容" : displayUrl(source.url),
        content: source.content as string,
        ...(source.diagnostics.length
          ? { diagnostics: source.diagnostics }
          : {}),
      }));

    if (activeSourceDocuments.length > 0 && !cancelRequested) {
      try {
        const result = await convertSourcesInWorker(activeSourceDocuments, {
          deduplicate: false,
          includeLossy: shouldIncludeLossyOutput(),
          signal: runController.signal,
        });
        aggregateResults(result);
        if (result.cancelled) cancelRequested = true;
      } catch (error) {
        appendLog(`统一转换失败：${failureFrom(error).message}`, true);
      } finally {
        if (conversionAbort === runController) conversionAbort = null;
      }
    }
    if (conversionAbort === runController) conversionAbort = null;

    completedSources = totalSources;
    running = false;
    setBusy(false);
    updateProgress(totalSources, totalSources);

    const successful = sourceResults.filter(
      (source) => source.state === "success",
    ).length;
    if (cancelRequested) setProcessingStatus("已取消", "warning");
    else if (successful === totalSources)
      setProcessingStatus("全部完成", "done");
    else if (successful > 0) setProcessingStatus("部分完成", "warning");
    else setProcessingStatus("处理失败", "error");

    const outputUris = getOutputUris();
    if (outputUris.length > 0) {
      dom.progressCopy.textContent = `转换完成 · ${successful} 个来源 · ${outputUris.length} 个唯一节点`;
      appendLog(
        `处理完成：成功 ${successful}/${totalSources} 个来源，输出 ${outputUris.length} 个唯一节点`,
      );
      showToast(`已生成 ${outputUris.length} 个节点 URI`);
    } else {
      dom.progressCopy.textContent = cancelRequested
        ? "处理已取消"
        : "转换结束，但没有获得可用节点";
      appendLog(
        `处理结束：成功 ${successful}/${totalSources} 个来源，没有可用节点`,
        true,
      );
      showToast("没有获得可用节点，请查看日志中的错误信息", true);
    }
    cancelRequested = false;
  }

  return {
    cancelConversion,
    isCancelled: () => cancelRequested,
    isRunning: () => running,
    refreshForConversionSettingChange,
    startConversion,
  };
}
