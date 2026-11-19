import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { failureFrom } from "./errors.ts";
import type { CategorizedOutput } from "./types.ts";

interface OutputActionsDependencies {
  getFilteredOutputEntries: () => CategorizedOutput[];
  getFilteredOutputUris: () => string[];
  isOutputFilterActive: () => boolean;
  captureOutputTableSnapshotForExport: () => ReturnType<
    typeof import("../core/output-table-snapshot.ts").captureOutputTableSnapshot
  >;
  setExportInProgress: (inProgress: boolean) => void;
  showToast: (message: string, isError?: boolean) => void;
}

export function createOutputActions({
  getFilteredOutputEntries,
  getFilteredOutputUris,
  isOutputFilterActive,
  captureOutputTableSnapshotForExport,
  setExportInProgress,
  showToast,
}: OutputActionsDependencies) {
  async function copyText(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      const fallback = document.createElement("textarea");
      fallback.value = value;
      fallback.style.position = "fixed";
      fallback.style.opacity = "0";
      document.body.append(fallback);
      fallback.select();
      const copied = document.execCommand("copy");
      fallback.remove();
      if (!copied) throw new Error("clipboard_unavailable");
    }
  }

  function safeFilePart(value: string): string {
    return value.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 48) || "output";
  }

  function defaultSaveName(fileName = "all"): string {
    const now = new Date();
    const pad = (value: number) => String(value).padStart(2, "0");
    return `chimera-subscriptions-${safeFilePart(fileName)}-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.txt`;
  }

  function defaultExcelSaveName(fileName = "all"): string {
    const now = new Date();
    const pad = (value: number) => String(value).padStart(2, "0");
    return `all2uri-${safeFilePart(fileName)}-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.xlsx`;
  }

  function defaultPngSaveName(fileName = "all"): string {
    const now = new Date();
    const pad = (value: number) => String(value).padStart(2, "0");
    return `all2uri-table-${safeFilePart(fileName)}-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.png`;
  }

  function bytesToBase64(bytes: Uint8Array): string {
    const chunks: string[] = [];
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      chunks.push(
        String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)),
      );
    }
    return btoa(chunks.join(""));
  }

  async function copyUris(uris: string[], label: string) {
    if (uris.length === 0) return;
    try {
      await copyText(uris.join("\n"));
      showToast(`已复制${label}的 ${uris.length} 个节点 URI`);
    } catch {
      showToast("复制失败，请手动选择文本框内容", true);
    }
  }

  async function copyFilteredOutput() {
    const uris = getFilteredOutputUris();
    await copyUris(uris, isOutputFilterActive() ? "筛选结果" : "全部输出");
  }

  async function saveUris(uris: string[], fileName: string, label: string) {
    if (uris.length === 0) return;
    try {
      const path = await save({
        defaultPath: defaultSaveName(fileName),
        filters: [{ name: "文本文件", extensions: ["txt"] }],
      });
      if (!path) return;
      await invoke<string>("save_text_file", {
        path,
        content: uris.join("\n"),
      });
      showToast(`已保存${label}的 ${uris.length} 个节点 URI`);
    } catch (error) {
      showToast(failureFrom(error).message || "保存文件失败", true);
    }
  }

  async function saveFilteredOutput() {
    const uris = getFilteredOutputUris();
    const filtered = isOutputFilterActive();
    await saveUris(
      uris,
      filtered ? "filtered" : "all",
      filtered ? "筛选结果" : "全部输出",
    );
  }

  async function saveOutputTableAsExcel() {
    if (getFilteredOutputEntries().length === 0) return;

    const filtered = isOutputFilterActive();
    try {
      const path = await save({
        defaultPath: defaultExcelSaveName(filtered ? "filtered" : "all"),
        filters: [{ name: "Excel 工作簿", extensions: ["xlsx"] }],
      });
      if (!path) return;

      setExportInProgress(true);
      const snapshot = captureOutputTableSnapshotForExport();
      if (!snapshot || snapshot.rows.length === 0) return;
      const { writeOutputTableWorkbook } = await import(
        "../core/output-table-excel.ts"
      );
      const bytes = await writeOutputTableWorkbook(snapshot);
      if (bytes.byteLength > 64 * 1024 * 1024) {
        throw new Error("Excel 文件超过 64 MiB，无法保存");
      }
      await invoke<string>("save_xlsx_file", {
        path,
        contentBase64: bytesToBase64(bytes),
      });
      showToast(`已保存 ${snapshot.rows.length} 个节点的 Excel 表格`);
    } catch (error) {
      showToast(failureFrom(error).message || "导出 Excel 表格失败", true);
    } finally {
      setExportInProgress(false);
    }
  }

  async function saveOutputTableAsPng() {
    if (getFilteredOutputEntries().length === 0) return;

    const filtered = isOutputFilterActive();
    try {
      const path = await save({
        defaultPath: defaultPngSaveName(filtered ? "filtered" : "all"),
        filters: [{ name: "PNG 图片", extensions: ["png"] }],
      });
      if (!path) return;

      setExportInProgress(true);
      const snapshot = captureOutputTableSnapshotForExport();
      if (!snapshot || snapshot.rows.length === 0) return;
      const { renderOutputTablePng } = await import(
        "../core/output-table-png.ts"
      );
      const bytes = await renderOutputTablePng(snapshot);
      if (bytes.byteLength > 64 * 1024 * 1024) {
        throw new Error("PNG 图片超过 64 MiB，无法保存");
      }
      await invoke<string>("save_png_file", {
        path,
        contentBase64: bytesToBase64(bytes),
      });
      showToast(`已保存 ${snapshot.rows.length} 个节点的 PNG 表格图片`);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : failureFrom(error).message;
      showToast(message || "导出 PNG 表格失败", true);
    } finally {
      setExportInProgress(false);
    }
  }
  return {
    copyFilteredOutput,
    saveFilteredOutput,
    saveOutputTableAsExcel,
    saveOutputTableAsPng,
  };
}
