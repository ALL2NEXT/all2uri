import jsQR from "jsqr";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { open } from "@tauri-apps/plugin-dialog";
import { detectSubscriptionInput } from "../core/subscription-import/index.ts";
import type { DomElements } from "./dom.ts";
import { failureFrom } from "./errors.ts";
import { MAX_BATCH_INPUT_BYTES } from "./limits.ts";

interface ImportControllerDependencies {
  dom: DomElements;
  isRunning: () => boolean;
  setValidation: (message?: string) => void;
  showToast: (message: string, isError?: boolean) => void;
}

export interface DetectedImportInput {
  urls: string[];
  local: string[];
  truncated: boolean;
  fragmentsTruncated: boolean;
  uriLimitReached: boolean;
  decodedTooLarge: number;
  depthLimited: boolean;
  inputTooLarge: boolean;
}

export function createImportController({
  dom,
  isRunning,
  setValidation,
  showToast,
}: ImportControllerDependencies) {
  let qrCaptureStream: MediaStream | null = null;
  let qrScanFrame: number | null = null;
  let qrScanCanvas: HTMLCanvasElement | null = null;
  let qrLastScanAt = 0;

  function readImportInput(): DetectedImportInput | null {
    const value = dom.urls.value.trim();
    if (!value) {
      setValidation("请先输入订阅 URL、节点 URI 或配置内容。");
      dom.urls.focus();
      return null;
    }

    const detected = detectSubscriptionInput(value);
    if (detected.inputTooLarge) {
      setValidation("输入内容超过 64 MiB 上限。");
      return null;
    }
    if (detected.urls.length === 0 && detected.local.length === 0) {
      setValidation("未检测到有效的订阅 URL、节点 URI 或配置内容。");
      dom.urls.focus();
      return null;
    }

    setValidation();
    return detected;
  }

  function replaceInputContent(content: string): boolean {
    if (!content.trim()) return false;
    if (new Blob([content]).size > MAX_BATCH_INPUT_BYTES) {
      showToast("导入内容超过 64 MiB 上限", true);
      return false;
    }
    dom.urls.value = content;
    setValidation();
    return true;
  }

  async function importClipboard() {
    if (isRunning()) return;
    try {
      const content = (await readText()).trim();
      if (!content) {
        showToast("剪贴板为空", true);
        return;
      }
      if (replaceInputContent(content)) showToast("已读取剪贴板内容");
    } catch {
      showToast("读取剪贴板失败，请检查剪贴板权限", true);
    }
  }

  // Android 智能识别窗口一次导入一个文本文件，并用文件内容替换输入框。
  async function importFile() {
    if (isRunning()) return;
    try {
      const selected = await open({ multiple: false, directory: false });
      if (typeof selected !== "string") return;
      const content = await invoke<string>("read_text_file", {
        path: selected,
      });
      if (!content.trim()) {
        showToast("文件内容为空", true);
        return;
      }
      if (replaceInputContent(content)) showToast("已读取文件内容");
    } catch (error) {
      showToast(failureFrom(error).message || "读取文件失败", true);
    }
  }

  function setInputDropTarget(active: boolean) {
    const isActive = active && !isRunning();
    dom.inputDropZone.classList.toggle("is-drop-target", isActive);
    dom.inputDropHint.hidden = !isActive;
  }

  function isInputDropPosition(position: { x: number; y: number }): boolean {
    // Tauri 返回物理像素坐标，需换算成 WebView 的 CSS 像素再判断是否落在输入框内。
    const bounds = dom.urls.getBoundingClientRect();
    const scaleFactor = window.devicePixelRatio || 1;
    const x = position.x / scaleFactor;
    const y = position.y / scaleFactor;
    return (
      x >= bounds.left &&
      x <= bounds.right &&
      y >= bounds.top &&
      y <= bounds.bottom
    );
  }

  async function importDroppedFiles(paths: string[]) {
    if (isRunning() || paths.length === 0) return;

    try {
      const contents: string[] = [];
      let totalBytes = 0;
      for (const path of new Set(paths)) {
        const content = await invoke<string>("read_text_file", { path });
        if (content.trim()) {
          totalBytes += new Blob([content]).size;
          if (totalBytes > MAX_BATCH_INPUT_BYTES) {
            showToast("导入内容超过 64 MiB 上限", true);
            return;
          }
          contents.push(content);
        }
      }

      if (contents.length === 0) {
        showToast("拖入的文件内容为空", true);
        return;
      }

      const combinedContent = contents.join("\n");
      if (replaceInputContent(combinedContent)) {
        showToast(
          contents.length === 1
            ? "已读取拖入文件"
            : `已读取 ${contents.length} 个拖入文件`,
        );
      }
    } catch (error) {
      showToast(failureFrom(error).message || "读取拖入文件失败", true);
    }
  }

  function bindInputFileDrop() {
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "leave") {
          setInputDropTarget(false);
          return;
        }

        const isOverInput = isInputDropPosition(payload.position);
        setInputDropTarget(isOverInput);
        if (payload.type !== "drop") return;

        setInputDropTarget(false);
        // 仅处理释放在输入框上的文件，内容沿用现有文本文件读取与大小校验逻辑。
        if (isOverInput) void importDroppedFiles(payload.paths);
      })
      .catch((error) => {
        console.error("无法监听文件拖放事件", error);
      });
  }

  function qrCameraErrorMessage(error: unknown): string {
    const name =
      typeof error === "object" && error !== null && "name" in error
        ? String((error as { name?: unknown }).name)
        : "";
    if (name === "NotAllowedError" || name === "SecurityError") {
      return "相机权限未获允许。请检查应用相机权限后重试。";
    }
    if (name === "NotFoundError" || name === "DevicesNotFoundError") {
      return "没有找到可用相机。";
    }
    if (name === "NotReadableError" || name === "TrackStartError") {
      return "相机正被其他应用占用，请关闭其他应用后重试。";
    }
    return "无法启动相机，请检查相机连接和权限。";
  }

  function decodeQrFromImage(
    source: CanvasImageSource,
    sourceWidth: number,
    sourceHeight: number,
    canvas: HTMLCanvasElement,
    maxSide: number,
  ): string | null {
    if (sourceWidth <= 0 || sourceHeight <= 0) return null;
    const scale = Math.min(1, maxSide / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("无法创建二维码扫描画布");
    context.drawImage(source, 0, 0, width, height);
    const image = context.getImageData(0, 0, width, height);
    return (
      jsQR(image.data, width, height, { inversionAttempts: "attemptBoth" })
        ?.data ?? null
    );
  }

  async function importQrImage(file: File) {
    if (file.size > 64 * 1024 * 1024) {
      showToast("图片文件超过 64 MiB 上限", true);
      return;
    }
    try {
      const bitmap = await createImageBitmap(file);
      let content: string | null;
      try {
        content =
          decodeQrFromImage(
            bitmap,
            bitmap.width,
            bitmap.height,
            document.createElement("canvas"),
            4096,
          )?.trim() ?? null;
      } finally {
        bitmap.close();
      }
      if (!content) {
        showToast("图片中未识别到二维码", true);
        return;
      }
      closeQrScanner();
      if (replaceInputContent(content)) showToast("已从图片读取二维码内容");
    } catch {
      showToast("无法读取图片，请选择有效的图片文件", true);
    }
  }

  function releaseQrCapture() {
    if (qrScanFrame !== null) {
      cancelAnimationFrame(qrScanFrame);
      qrScanFrame = null;
    }
    qrCaptureStream?.getTracks().forEach((track) => track.stop());
    qrCaptureStream = null;
    dom.qrScannerVideo.pause();
    dom.qrScannerVideo.srcObject = null;
    qrScanCanvas = null;
    qrLastScanAt = 0;
  }

  function closeQrScanner() {
    releaseQrCapture();
    if (dom.qrScannerDialog.open) dom.qrScannerDialog.close();
  }

  function showQrCaptureError(message: string, retryable = true) {
    releaseQrCapture();
    dom.qrScannerSourceOptions.hidden = false;
    dom.qrScannerPreview.hidden = true;
    dom.qrScannerStatus.textContent = message;
    dom.qrScannerStatus.hidden = false;
    dom.qrScannerSourceBack.hidden = true;
    dom.qrScannerRetry.hidden = !retryable;
    dom.qrScannerRetry.textContent = "重试摄像头";
  }

  function returnToQrSourceOptions() {
    releaseQrCapture();
    dom.qrScannerSourceOptions.hidden = false;
    dom.qrScannerPreview.hidden = true;
    dom.qrScannerStatus.hidden = true;
    dom.qrScannerStatus.textContent = "";
    dom.qrScannerSourceBack.hidden = true;
    dom.qrScannerRetry.hidden = true;
  }

  function scanQrVideoFrame(now: number) {
    qrScanFrame = null;
    if (!dom.qrScannerDialog.open || !qrCaptureStream) return;
    qrScanFrame = requestAnimationFrame(scanQrVideoFrame);
    if (
      now - qrLastScanAt < 180 ||
      dom.qrScannerVideo.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
    )
      return;
    qrLastScanAt = now;

    try {
      const video = dom.qrScannerVideo;
      const maxSide = 1920;
      qrScanCanvas ??= document.createElement("canvas");
      const content = decodeQrFromImage(
        video,
        video.videoWidth,
        video.videoHeight,
        qrScanCanvas,
        maxSide,
      )?.trim();
      if (!content) return;

      closeQrScanner();
      if (replaceInputContent(content)) showToast("已读取二维码内容");
    } catch {
      showQrCaptureError("读取相机画面失败，请重试。");
    }
  }

  async function startQrCamera() {
    releaseQrCapture();
    dom.qrScannerSourceOptions.hidden = true;
    dom.qrScannerPreview.hidden = true;
    dom.qrScannerStatus.hidden = false;
    dom.qrScannerStatus.textContent = "正在启动相机…";
    dom.qrScannerSourceBack.hidden = true;
    dom.qrScannerRetry.hidden = true;
    try {
      if (!navigator.mediaDevices?.getUserMedia)
        throw new Error("camera_capture_unavailable");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
      if (!dom.qrScannerDialog.open) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      qrCaptureStream = stream;
      stream.getVideoTracks().forEach((track) =>
        track.addEventListener(
          "ended",
          () => {
            if (qrCaptureStream !== stream || !dom.qrScannerDialog.open) return;
            showQrCaptureError("相机已停止。", false);
          },
          { once: true },
        ),
      );
      dom.qrScannerVideo.srcObject = stream;
      await dom.qrScannerVideo.play();
      if (!dom.qrScannerDialog.open) {
        releaseQrCapture();
        return;
      }
      dom.qrScannerPreview.hidden = false;
      dom.qrScannerStatus.textContent = "请将二维码放入取景框。";
      dom.qrScannerSourceBack.hidden = false;
      qrScanFrame = requestAnimationFrame(scanQrVideoFrame);
    } catch (error) {
      if (!dom.qrScannerDialog.open) {
        releaseQrCapture();
        return;
      }
      const message =
        error instanceof Error && error.message.endsWith("_unavailable")
          ? "当前运行环境不支持摄像头扫码。"
          : qrCameraErrorMessage(error);
      showQrCaptureError(message, !message.includes("不支持"));
    }
  }

  async function scanFullScreens() {
    if (isRunning() || !dom.qrScannerDialog.open) return;
    dom.qrScannerSourceOptions.hidden = true;
    dom.qrScannerPreview.hidden = true;
    dom.qrScannerStatus.hidden = false;
    dom.qrScannerStatus.textContent = "正在截取所有屏幕…";
    dom.qrScannerSourceBack.hidden = true;
    dom.qrScannerRetry.hidden = true;

    try {
      const screenshots = await invoke<string[]>("capture_full_screens");
      let content: string | null = null;
      for (const encoded of screenshots) {
        const binary = atob(encoded);
        const bytes = Uint8Array.from(binary, (character) =>
          character.charCodeAt(0),
        );
        const bitmap = await createImageBitmap(
          new Blob([bytes], { type: "image/png" }),
        );
        try {
          content =
            decodeQrFromImage(
              bitmap,
              bitmap.width,
              bitmap.height,
              document.createElement("canvas"),
              4096,
            )?.trim() ?? null;
        } finally {
          bitmap.close();
        }
        if (content) break;
      }

      if (!content) {
        dom.qrScannerSourceOptions.hidden = false;
        dom.qrScannerStatus.textContent =
          "全屏中未识别到二维码，可以重试或选择其他来源。";
        return;
      }
      closeQrScanner();
      if (replaceInputContent(content)) showToast("已从全屏读取二维码内容");
    } catch (error) {
      dom.qrScannerSourceOptions.hidden = false;
      dom.qrScannerStatus.textContent =
        failureFrom(error).message || "全屏扫描失败，请重试。";
    }
  }

  async function importQrCode() {
    if (isRunning() || dom.qrScannerDialog.open) return;
    returnToQrSourceOptions();
    dom.qrScannerRetry.hidden = true;
    dom.qrScannerDialog.showModal();
  }

  function handleQrImageSelection() {
    const file = dom.qrImageInput.files?.[0];
    dom.qrImageInput.value = "";
    if (file) void importQrImage(file);
  }

  return {
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
  };
}
