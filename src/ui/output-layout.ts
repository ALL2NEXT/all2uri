import type { DomElements } from "./dom.ts";
import type { CategorizedOutput, OutputTableColumn } from "./types.ts";
import { OUTPUT_COLUMN_MIN_WIDTH } from "./output-options.ts";
import {
  loadOutputColumnWidths,
  saveOutputColumnWidths,
} from "./settings-store.ts";

interface OutputLayoutDependencies {
  dom: DomElements;
  getRenderedOutputColumns: () => OutputTableColumn[];
  getFilteredOutputEntries: () => CategorizedOutput[];
  renderOutputTableRow: (
    entry: CategorizedOutput,
    index: number,
  ) => HTMLTableRowElement;
  handleOutputTableScroll: () => void;
  scheduleOutputTableRows: () => void;
}

export function createOutputLayout({
  dom,
  getRenderedOutputColumns,
  getFilteredOutputEntries,
  renderOutputTableRow,
  handleOutputTableScroll,
  scheduleOutputTableRows,
}: OutputLayoutDependencies) {
  interface ResizeState {
    index: number;
    pointerId: number;
    startX: number;
    availableWidth: number;
    startRatios: number[];
  }

  interface OutputColumnResizeState {
    columnKey: string;
    pointerId: number;
    startX: number;
    startWidth: number;
    handle: HTMLElement;
  }

  const MIN_PANEL_WIDTH = 280;
  const SPLITTER_WIDTH = 13;
  const DEFAULT_PANEL_RATIOS = [0.72, 0.28];

  let panelRatios = [...DEFAULT_PANEL_RATIOS];
  let resizeState: ResizeState | null = null;
  let outputColumnWidths = loadOutputColumnWidths();
  let outputColumnResizeState: OutputColumnResizeState | null = null;
  function availableWorkspaceWidth(): number {
    const columnGap =
      Number.parseFloat(getComputedStyle(dom.workspace).columnGap) || 0;
    const gapsWidth =
      columnGap * Math.max(0, dom.workspace.children.length - 1);
    return Math.max(
      0,
      dom.workspace.getBoundingClientRect().width -
        dom.panelResizers.length * SPLITTER_WIDTH -
        gapsWidth,
    );
  }

  function clampPanelRatios(
    ratios: number[],
    availableWidth: number,
  ): number[] {
    if (availableWidth <= 0) return [...DEFAULT_PANEL_RATIOS];
    const minRatio = MIN_PANEL_WIDTH / availableWidth;
    let next = ratios.map((ratio) => Math.max(minRatio, ratio));
    let total = next.reduce((sum, ratio) => sum + ratio, 0);
    if (total > 1) {
      const reducible = next.map((ratio) => Math.max(0, ratio - minRatio));
      const reducibleTotal = reducible.reduce((sum, ratio) => sum + ratio, 0);
      if (reducibleTotal > 0) {
        const excess = total - 1;
        next = next.map(
          (ratio, index) =>
            ratio - excess * (reducible[index] / reducibleTotal),
        );
      }
    }
    total = next.reduce((sum, ratio) => sum + ratio, 0);
    return total > 0
      ? next.map((ratio) => ratio / total)
      : [...DEFAULT_PANEL_RATIOS];
  }

  function applyPanelRatios() {
    dom.workspace.style.setProperty("--panel-a", `${panelRatios[0]}fr`);
    dom.workspace.style.setProperty("--panel-b", `${panelRatios[1]}fr`);
  }

  function adjustPanelRatios(index: number, delta: number) {
    const availableWidth = availableWorkspaceWidth();
    if (availableWidth <= 0) return;
    const minRatio = MIN_PANEL_WIDTH / availableWidth;
    const next = [...panelRatios];
    const clamped = Math.min(
      Math.max(delta, minRatio - next[index]),
      next[index + 1] - minRatio,
    );
    next[index] += clamped;
    next[index + 1] -= clamped;
    panelRatios = clampPanelRatios(next, availableWidth);
    applyPanelRatios();
  }

  function resetPanelRatios() {
    panelRatios = clampPanelRatios(
      [...DEFAULT_PANEL_RATIOS],
      availableWorkspaceWidth(),
    );
    applyPanelRatios();
  }

  function applyOutputColumnWidths() {
    const columns = Array.from(
      dom.outputTableColumns.querySelectorAll<HTMLTableColElement>(
        "col[data-column-key]",
      ),
    );
    let columnsWidth = 0;
    for (const column of columns) {
      const key = column.dataset.columnKey;
      if (!key) continue;
      const width =
        outputColumnWidths[key] ??
        (Number(column.dataset.defaultWidth) || OUTPUT_COLUMN_MIN_WIDTH);
      column.style.width = `${width}px`;
      columnsWidth += width;
    }
    const filler = dom.outputTableColumns.querySelector<HTMLTableColElement>(
      "col.output-table-filler",
    );
    if (filler) filler.style.width = "auto";
    dom.outputTable.style.width = `${Math.max(dom.outputTableWrap.clientWidth, columnsWidth)}px`;
    dom.outputTable
      .querySelectorAll<HTMLElement>(".output-column-resizer")
      .forEach((handle) => {
        const key = handle.dataset.columnKey;
        if (!key) return;
        const width =
          outputColumnWidths[key] ??
          (Number(handle.dataset.defaultWidth) || OUTPUT_COLUMN_MIN_WIDTH);
        handle.setAttribute("aria-valuenow", `${Math.round(width)}`);
        handle.setAttribute("aria-valuemin", `${OUTPUT_COLUMN_MIN_WIDTH}`);
        // 分隔条只报告可访问性范围，不限制实际拖动宽度。
        handle.setAttribute(
          "aria-valuemax",
          `${Math.max(10_000, Math.round(width))}`,
        );
      });
  }

  function resizeOutputColumn(columnKey: string, width: number) {
    if (!getRenderedOutputColumns().some((column) => column.key === columnKey))
      return;
    outputColumnWidths[columnKey] = Math.max(OUTPUT_COLUMN_MIN_WIDTH, width);
    applyOutputColumnWidths();
  }

  // 参考 v2rayN 的 Auto 列宽行为，用隐藏表格测量当前筛选结果并保存自适应宽度。
  function autoFitOutputColumnWidths() {
    const wrapper = document.createElement("div");
    wrapper.className = "output-table-wrap output-table-autofit-staging";
    wrapper.setAttribute("aria-hidden", "true");
    wrapper.style.position = "fixed";
    wrapper.style.left = "-100000px";
    wrapper.style.top = "0";
    wrapper.style.width = "max-content";
    wrapper.style.height = "max-content";
    wrapper.style.maxWidth = "none";
    wrapper.style.maxHeight = "none";
    wrapper.style.flex = "none";
    wrapper.style.overflow = "visible";
    wrapper.style.visibility = "hidden";
    wrapper.style.pointerEvents = "none";

    const table = dom.outputTable.cloneNode(true) as HTMLTableElement;
    table.style.width = "max-content";
    table.style.minWidth = "0";
    table.style.maxWidth = "none";
    table.style.tableLayout = "auto";
    for (const column of table.querySelectorAll<HTMLTableColElement>(
      "col[data-column-key]",
    )) {
      column.style.removeProperty("width");
    }

    const body = table.tBodies[0];
    if (!body) return;
    const rows = document.createDocumentFragment();
    const entries = getFilteredOutputEntries();
    for (let index = 0; index < entries.length; index += 1) {
      rows.append(renderOutputTableRow(entries[index]!, index));
    }
    body.replaceChildren(rows);
    table
      .querySelectorAll(".output-table-filler")
      .forEach((element) => element.remove());
    table.querySelectorAll<HTMLTableCellElement>("th, td").forEach((cell) => {
      cell.style.overflow = "visible";
    });
    table
      .querySelectorAll<HTMLElement>(
        ".output-table-primary, .output-table-truncate",
      )
      .forEach((element) => {
        element.style.width = "max-content";
        element.style.maxWidth = "none";
        element.style.overflow = "visible";
        element.style.textOverflow = "clip";
      });
    wrapper.append(table);
    document.body.append(wrapper);

    try {
      const columns = Array.from(
        table.querySelectorAll<HTMLTableColElement>("col[data-column-key]"),
      );
      const headers = Array.from(table.tHead?.rows[0]?.cells ?? []);
      for (const [index, column] of columns.entries()) {
        const key = column.dataset.columnKey;
        if (!key) continue;
        const measuredWidth =
          headers[index]?.getBoundingClientRect().width ?? 0;
        const fallbackWidth =
          Number(column.dataset.defaultWidth) || OUTPUT_COLUMN_MIN_WIDTH;
        outputColumnWidths[key] = Math.max(
          OUTPUT_COLUMN_MIN_WIDTH,
          Math.ceil(measuredWidth > 0 ? measuredWidth : fallbackWidth),
        );
      }
    } finally {
      wrapper.remove();
    }

    applyOutputColumnWidths();
    saveOutputColumnWidths(outputColumnWidths);
  }

  function bindOutputTableColumnResizers() {
    dom.outputTable.addEventListener("pointerdown", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const handle = target.closest<HTMLElement>(".output-column-resizer");
      const columnKey = handle?.dataset.columnKey;
      if (!handle || !columnKey || event.button !== 0) return;
      event.preventDefault();
      const defaultWidth =
        Number(handle.dataset.defaultWidth) || OUTPUT_COLUMN_MIN_WIDTH;
      outputColumnResizeState = {
        columnKey,
        pointerId: event.pointerId,
        startX: event.clientX,
        startWidth: outputColumnWidths[columnKey] ?? defaultWidth,
        handle,
      };
      try {
        handle.setPointerCapture(event.pointerId);
      } catch {
        // 后续窗口级指针事件仍可继续处理拖动。
      }
      handle.classList.add("is-active");
      document.body.classList.add("resizing-output-columns");
    });

    window.addEventListener("pointermove", (event) => {
      const state = outputColumnResizeState;
      if (!state || event.pointerId !== state.pointerId) return;
      resizeOutputColumn(
        state.columnKey,
        state.startWidth + event.clientX - state.startX,
      );
    });

    const endResize = (event: PointerEvent) => {
      const state = outputColumnResizeState;
      if (!state || event.pointerId !== state.pointerId) return;
      try {
        if (state.handle.hasPointerCapture(event.pointerId))
          state.handle.releasePointerCapture(event.pointerId);
      } catch {
        // 释放失败时不影响结束逻辑。
      }
      state.handle.classList.remove("is-active");
      document.body.classList.remove("resizing-output-columns");
      outputColumnResizeState = null;
      saveOutputColumnWidths(outputColumnWidths);
    };
    window.addEventListener("pointerup", endResize);
    window.addEventListener("pointercancel", endResize);

    dom.outputTable.addEventListener("keydown", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const handle = target.closest<HTMLElement>(".output-column-resizer");
      const columnKey = handle?.dataset.columnKey;
      if (
        !handle ||
        !columnKey ||
        (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
      )
        return;
      event.preventDefault();
      const defaultWidth =
        Number(handle.dataset.defaultWidth) || OUTPUT_COLUMN_MIN_WIDTH;
      const step = event.shiftKey ? 20 : 8;
      const delta = event.key === "ArrowLeft" ? -step : step;
      resizeOutputColumn(
        columnKey,
        (outputColumnWidths[columnKey] ?? defaultWidth) + delta,
      );
      saveOutputColumnWidths(outputColumnWidths);
    });

    applyOutputColumnWidths();
    dom.outputTableWrap.addEventListener("scroll", handleOutputTableScroll, {
      passive: true,
    });
    new ResizeObserver(() => {
      applyOutputColumnWidths();
      scheduleOutputTableRows();
    }).observe(dom.outputTableWrap);
  }

  function bindPanelResizers() {
    dom.panelResizers.forEach((handle, index) => {
      handle.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        const availableWidth = availableWorkspaceWidth();
        if (availableWidth <= 0) return;
        resizeState = {
          index,
          pointerId: event.pointerId,
          startX: event.clientX,
          availableWidth,
          startRatios: [...panelRatios],
        };
        try {
          handle.setPointerCapture(event.pointerId);
        } catch {
          // 指针捕获不可用时继续使用窗口级事跟踪
        }
        handle.classList.add("is-active");
        document.body.classList.add("resizing-panels");
      });

      handle.addEventListener("pointermove", (event) => {
        if (
          !resizeState ||
          resizeState.index !== index ||
          event.pointerId !== resizeState.pointerId
        )
          return;
        const minRatio = MIN_PANEL_WIDTH / resizeState.availableWidth;
        const next = [...resizeState.startRatios];
        const rawDelta =
          (event.clientX - resizeState.startX) / resizeState.availableWidth;
        const clamped = Math.min(
          Math.max(rawDelta, minRatio - next[index]),
          next[index + 1] - minRatio,
        );
        next[index] += clamped;
        next[index + 1] -= clamped;
        panelRatios = clampPanelRatios(next, resizeState.availableWidth);
        applyPanelRatios();
      });

      const endResize = (event: PointerEvent) => {
        if (!resizeState || resizeState.index !== index) return;
        try {
          if (handle.hasPointerCapture(event.pointerId))
            handle.releasePointerCapture(event.pointerId);
        } catch {
          // 释放失败时不影响结束逻辑
        }
        handle.classList.remove("is-active");
        document.body.classList.remove("resizing-panels");
        resizeState = null;
      };
      handle.addEventListener("pointerup", endResize);
      handle.addEventListener("pointercancel", endResize);
      window.addEventListener("pointerup", endResize);
      window.addEventListener("pointercancel", endResize);
      handle.addEventListener("dblclick", resetPanelRatios);
      handle.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        adjustPanelRatios(index, event.key === "ArrowLeft" ? -0.02 : 0.02);
      });
    });

    window.addEventListener("resize", () => {
      if (window.innerWidth <= 760) return;
      panelRatios = clampPanelRatios(panelRatios, availableWorkspaceWidth());
      applyPanelRatios();
    });
  }
  return {
    bindOutputTableColumnResizers,
    bindPanelResizers,
    applyPanelRatios,
    applyOutputColumnWidths,
    autoFitOutputColumnWidths,
  };
}
