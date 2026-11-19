import { invoke } from "@tauri-apps/api/core";
import { convertSourcesInWorker } from "../core/worker-client.ts";
import type { ConversionResult } from "../core/pipeline.ts";
import { ConversionError, failureFrom } from "./errors.ts";

export interface FetchedSubscription {
  content: string;
  finalUrl: string;
  contentType: string | null;
  subscriptionUserInfo: string | null;
  bytes: number;
  usedUserAgent: string;
}

export const MIN_FETCH_CONCURRENCY = 1;
export const MIN_REMOTE_TIMEOUT_SECONDS = 1;
export const DEFAULT_REMOTE_TIMEOUT_SECONDS = 30;
export const MIN_REMOTE_BATCH_BYTES = 1024 * 1024;
export const USER_AGENT_PRESETS: Record<string, string> = {
  nekobox: "NekoBox/Android/1.4.2 (Prefer ClashMeta Format)",
  "sing-box": "sing-box/1.15.0",
  clash: "clash-meta/1.19.0",
  v2rayn: "v2rayN/7.8.2",
};

interface SubscriptionFetcherDependencies {
  isCancelled: () => boolean;
  shouldSkipCertificateVerification: () => boolean;
  appendLog: (message: string, isError?: boolean) => void;
  displayUrl: (url: string) => string;
}

export function createSubscriptionFetcher({
  isCancelled,
  shouldSkipCertificateVerification,
  appendLog,
  displayUrl,
}: SubscriptionFetcherDependencies) {
  const activeFetchRequests = new Set<string>();
  async function runWithConcurrency<T>(
    items: T[],
    concurrency: number,
    worker: (item: T, index: number) => Promise<void>,
  ) {
    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(concurrency, items.length) },
      async () => {
        while (cursor < items.length && !isCancelled()) {
          const index = cursor++;
          await worker(items[index], index);
        }
      },
    );
    await Promise.all(workers);
  }

  function shouldRetryAutomaticUserAgent(result: ConversionResult): boolean {
    if (result.stats.parsedNodes > 0) return false;
    return result.diagnostics.some((item) =>
      [
        "unknown_format",
        "no_native_nodes",
        "no_proxy_section",
        "no_uri_nodes",
      ].includes(item.code),
    );
  }

  async function probeSubscription(
    content: string,
    sourceId: string,
    signal?: AbortSignal,
  ): Promise<ConversionResult> {
    return convertSourcesInWorker(
      [{ sourceId, sourceName: "User-Agent probe", content }],
      {
        deduplicate: false,
        includeLossy: true,
        signal,
      },
    );
  }

  async function fetchSubscriptionWithFallback(
    url: string,
    userAgent: string | null,
    maxRedirects: number,
    timeoutSeconds: number,
    sourceId: string,
    requestId: string,
    signal: AbortSignal,
  ): Promise<FetchedSubscription> {
    let requestAttempt = 0;
    const fetch = async (agent: string | null) => {
      if (signal.aborted)
        throw new ConversionError("cancelled", "处理已取消。");
      const activeRequestId = `${requestId}:${++requestAttempt}`;
      const cancelRequest = () => {
        void invoke<boolean>("cancel_subscription", {
          requestId: activeRequestId,
        }).catch(() => undefined);
      };
      activeFetchRequests.add(activeRequestId);
      signal.addEventListener("abort", cancelRequest, { once: true });
      if (signal.aborted) cancelRequest();
      try {
        return await invoke<FetchedSubscription>("fetch_subscription", {
          url,
          userAgent: agent,
          requestId: activeRequestId,
          skipCertificateVerification: shouldSkipCertificateVerification(),
          maxRedirects,
          timeoutSeconds,
        });
      } finally {
        signal.removeEventListener("abort", cancelRequest);
        activeFetchRequests.delete(activeRequestId);
      }
    };

    let fetched = await fetch(userAgent);
    if (userAgent !== null) return fetched;
    let probe = await probeSubscription(fetched.content, sourceId, signal);
    if (!shouldRetryAutomaticUserAgent(probe)) return fetched;

    const tried = new Set([fetched.usedUserAgent]);
    for (const agent of Object.values(USER_AGENT_PRESETS)) {
      if (isCancelled()) return fetched;
      if (tried.has(agent)) continue;
      tried.add(agent);
      appendLog(
        `远程订阅 ${displayUrl(url)}：内容无法识别，改用 ${agent} 重试`,
      );
      try {
        const candidate = await fetch(agent);
        const candidateProbe = await probeSubscription(
          candidate.content,
          sourceId,
          signal,
        );
        fetched = candidate;
        probe = candidateProbe;
        if (!shouldRetryAutomaticUserAgent(candidateProbe)) return candidate;
      } catch (error) {
        appendLog(
          `User-Agent ${agent} 重试失败：${failureFrom(error).message}`,
        );
      }
    }
    return fetched;
  }
  function cancelActiveRequests() {
    for (const requestId of activeFetchRequests) {
      void invoke<boolean>("cancel_subscription", { requestId }).catch(
        () => undefined,
      );
    }
  }

  return {
    runWithConcurrency,
    fetchSubscriptionWithFallback,
    cancelActiveRequests,
  };
}
