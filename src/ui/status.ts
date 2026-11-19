import { dom } from "./dom.ts";
import type { ProcessingState } from "./types.ts";

export function createStatusUi(getIsRunning: () => boolean) {
  let toastTimer: number | undefined;

  function setValidation(message = "", warning = false) {
    dom.validation.textContent = message;
    dom.validation.hidden = !message;
    dom.validation.classList.toggle("warning", warning);
  }

  function showToast(message: string, error = false) {
    window.clearTimeout(toastTimer);
    dom.toast.textContent = message;
    dom.toast.classList.toggle("error", error);
    dom.toast.classList.add("visible");
    toastTimer = window.setTimeout(
      () => dom.toast.classList.remove("visible"),
      3200,
    );
  }

  function appendLog(message: string, error = false) {
    const line = document.createElement("div");
    line.className = error ? "log-line error" : "log-line";
    const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    line.textContent = `[${time}] ${message}`;
    dom.logList.append(line);
    dom.logList.scrollTop = dom.logList.scrollHeight;
  }

  function clearLog() {
    dom.logList.replaceChildren();
  }

  function setProcessingStatus(label: string, state: ProcessingState) {
    dom.processingStatus.textContent = label;
    dom.processingStatus.dataset.state = state;
    dom.processingStatus.hidden = state === "idle" || !label;
  }

  function updateProgress(done: number, total: number) {
    const percent = total === 0 ? 0 : Math.round((done / total) * 100);
    dom.progressBar.style.width = `${percent}%`;
    dom.progressCopy.textContent = getIsRunning()
      ? `正在处理 ${done} / ${total} 个来源 · ${percent}%`
      : `已处理 ${done} / ${total} 个来源`;
  }

  function updateNodeTestProgress(done: number, total: number, label: string) {
    const percent = total === 0 ? 0 : Math.round((done / total) * 100);
    dom.progressBar.style.width = `${percent}%`;
    dom.progressCopy.textContent = `${label} · ${done} / ${total} 个节点 · ${percent}%`;
  }

  return {
    setValidation,
    showToast,
    appendLog,
    clearLog,
    setProcessingStatus,
    updateProgress,
    updateNodeTestProgress,
  };
}
