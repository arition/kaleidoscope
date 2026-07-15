import { createComparisonState } from "./comparison.js";
import type {
  ComparisonState,
  ComparisonTransition,
} from "./comparison.js";
import type {
  ClipId,
  ClipMetadata,
  ComparisonMode,
  PreviewMetadataMessage,
} from "./protocol.js";

export interface ComparisonViewController {
  readonly toolbar: HTMLElement;
  readonly view: HTMLElement;
  compose(): void;
  prepareCommit(
    candidateCanvases: ReadonlyMap<ClipId, HTMLCanvasElement>,
  ): () => void;
  setState(state: ComparisonState, deferComposition?: boolean): void;
}

interface ComparisonViewOptions {
  metadata: PreviewMetadataMessage;
  canvases: Map<ClipId, HTMLCanvasElement>;
  rows: Map<ClipId, HTMLElement>;
  modeLabel: HTMLElement;
  clips: HTMLElement;
  onChange?: (transition: ComparisonTransition) => void;
  updateClipRow(
    row: HTMLElement,
    clip: ClipMetadata,
    active: boolean,
    aligned: boolean,
    canvases: Map<ClipId, HTMLCanvasElement>,
  ): void;
  signal?: AbortSignal;
}

const ALIGNED_MODES: ReadonlySet<ComparisonMode> = new Set([
  "wipe",
  "overlay",
  "difference",
]);

const idsMatch = (left: ClipId, right: ClipId): boolean => left === right;

export function createComparisonView(
  options: ComparisonViewOptions,
): ComparisonViewController {
  const {
    metadata,
    canvases,
    rows,
    modeLabel,
    clips,
    onChange,
    updateClipRow,
    signal,
  } = options;
  let state = createComparisonState(metadata);
  let committedState = state;

  const toolbar = document.createElement("div");
  toolbar.className = "kaleidoscope-comparison-toolbar";

  const modeControl = document.createElement("div");
  modeControl.className = "kaleidoscope-mode-control";
  modeControl.setAttribute("role", "group");
  modeControl.setAttribute("aria-label", "Comparison mode");

  const selectionControl = document.createElement("div");
  selectionControl.className = "kaleidoscope-selection-control";
  toolbar.append(modeControl, selectionControl);

  const comparison = document.createElement("figure");
  comparison.className = "kaleidoscope-comparison";
  comparison.hidden = true;

  const comparisonLabels = document.createElement("figcaption");
  comparisonLabels.className = "kaleidoscope-comparison__labels";

  const comparisonStage = document.createElement("div");
  comparisonStage.className = "kaleidoscope-comparison__stage";

  const createComparisonCanvas = (): HTMLCanvasElement => {
    const canvas = document.createElement("canvas");
    canvas.className = "kaleidoscope-comparison__canvas";
    canvas.setAttribute("role", "img");
    return canvas;
  };
  let comparisonCanvas = createComparisonCanvas();
  let stagingComparisonCanvas = createComparisonCanvas();
  comparisonStage.append(comparisonCanvas);

  const comparisonParameters = document.createElement("div");
  comparisonParameters.className = "kaleidoscope-comparison__parameters";
  comparison.append(comparisonLabels, comparisonStage, comparisonParameters);

  const clipForId = (clipId: ClipId): ClipMetadata => {
    const clip = metadata.clips.find((candidate) => idsMatch(candidate.id, clipId));
    if (clip === undefined) {
      throw new Error(`Unknown clip ID ${String(clipId)}.`);
    }
    return clip;
  };

  const optionValue = (clipId: ClipId): string =>
    String(metadata.clips.findIndex((clip) => idsMatch(clip.id, clipId)));
  const optionClipId = (value: string): ClipId =>
    metadata.clips[Number(value)].id;

  const createClipSelect = (
    label: string,
    selected: ClipId,
    onSelect: (clipId: ClipId) => void,
    disabled?: (clip: ClipMetadata) => boolean,
  ): HTMLSelectElement => {
    const select = document.createElement("select");
    select.className = "kaleidoscope-clip-select";
    select.setAttribute("aria-label", label);
    select.disabled = onChange === undefined;
    for (const clip of metadata.clips) {
      const option = document.createElement("option");
      option.value = optionValue(clip.id);
      option.textContent = clip.label;
      option.disabled = disabled?.(clip) ?? false;
      option.selected = idsMatch(clip.id, selected);
      select.append(option);
    }
    select.addEventListener("change", () => onSelect(optionClipId(select.value)), {
      signal,
    });
    return select;
  };

  const modeButtons = new Map<ComparisonMode, HTMLButtonElement>();
  if (metadata.clips.length > 1) {
    const modes: ReadonlyArray<readonly [ComparisonMode, string]> = [
      ["single", "Single"],
      ["side-by-side", "Side by side"],
      ["wipe", "Wipe"],
      ["overlay", "Overlay"],
      ["difference", "Difference"],
    ];
    const hasAlignedPair = metadata.clips.some((first, firstIndex) =>
      metadata.clips.some(
        (second, secondIndex) =>
          firstIndex !== secondIndex &&
          first.source_width === second.source_width &&
          first.source_height === second.source_height,
      ),
    );
    for (const [value, label] of modes) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "kaleidoscope-mode-button";
      button.textContent = label;
      button.title = `${label} view`;
      button.setAttribute("aria-label", `${label} view`);
      button.disabled =
        onChange === undefined ||
        (ALIGNED_MODES.has(value) &&
          (!hasAlignedPair || metadata.max_visible_clips < 2));
      button.addEventListener("click", () => onChange?.({ mode: value }), {
        signal,
      });
      modeButtons.set(value, button);
      modeControl.append(button);
    }
  }

  const renderSelectionControls = (): void => {
    selectionControl.replaceChildren();
    if (state.mode === "single") {
      selectionControl.append(
        createClipSelect("Solo clip", state.primary, (primary) =>
          onChange?.({ primary }),
        ),
      );
      return;
    }

    if (state.mode === "side-by-side") {
      const selected = state.activeClipIds;
      for (const clip of metadata.clips) {
        const label = document.createElement("label");
        label.className = "kaleidoscope-clip-toggle";

        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = selected.some((clipId) => idsMatch(clipId, clip.id));
        checkbox.disabled =
          onChange === undefined ||
          (checkbox.checked
            ? selected.length === 1
            : selected.length >= metadata.max_visible_clips);
        checkbox.setAttribute("aria-label", `Show ${clip.label}`);
        checkbox.addEventListener(
          "change",
          () => {
            const next = checkbox.checked
              ? [...selected, clip.id]
              : selected.filter((clipId) => !idsMatch(clipId, clip.id));
            onChange?.({ selectedClipIds: next });
          },
          { signal },
        );

        const text = document.createElement("span");
        text.textContent = clip.label;
        label.append(checkbox, text);
        selectionControl.append(label);
      }
      return;
    }

    const primaryClip = clipForId(state.primary);
    const secondary = state.secondary;
    if (secondary === undefined) {
      return;
    }
    const primary = createClipSelect(
      "Comparison clip A",
      state.primary,
      (primaryId) => onChange?.({ primary: primaryId }),
      (clip) =>
        !metadata.clips.some(
          (candidate) =>
            !idsMatch(candidate.id, clip.id) &&
            candidate.source_width === clip.source_width &&
            candidate.source_height === clip.source_height,
        ),
    );
    const secondarySelect = createClipSelect(
      "Comparison clip B",
      secondary,
      (secondaryId) => onChange?.({ secondary: secondaryId }),
      (clip) =>
        idsMatch(clip.id, state.primary) ||
        clip.source_width !== primaryClip.source_width ||
        clip.source_height !== primaryClip.source_height,
    );
    selectionControl.append(primary, secondarySelect);
  };

  const renderComparisonParameters = (): void => {
    comparisonParameters.replaceChildren();
    comparisonStage.querySelector(".kaleidoscope-wipe")?.remove();
    if (state.mode === "wipe") {
      const wipe = document.createElement("input");
      wipe.type = "range";
      wipe.className = "kaleidoscope-wipe";
      wipe.min = "0";
      wipe.max = "100";
      wipe.step = "1";
      wipe.value = String(Math.round(state.wipePosition * 100));
      wipe.setAttribute("aria-label", "Wipe position");
      wipe.addEventListener(
        "input",
        () => onChange?.({ wipePosition: Number(wipe.value) / 100 }),
        { signal },
      );
      comparisonStage.append(wipe);
    } else if (state.mode === "overlay") {
      const label = document.createElement("label");
      label.className = "kaleidoscope-parameter";

      const text = document.createElement("span");
      text.textContent = "B opacity";

      const opacity = document.createElement("input");
      opacity.type = "range";
      opacity.min = "0";
      opacity.max = "1";
      opacity.step = "0.01";
      opacity.value = String(state.overlayOpacity);
      opacity.setAttribute("aria-label", "Overlay opacity");

      const output = document.createElement("output");
      output.textContent = `${Math.round(state.overlayOpacity * 100)}%`;
      opacity.addEventListener(
        "input",
        () => onChange?.({ overlayOpacity: Number(opacity.value) }),
        { signal },
      );
      label.append(text, opacity, output);
      comparisonParameters.append(label);
    } else if (state.mode === "difference") {
      const note = document.createElement("span");
      note.className = "kaleidoscope-difference-note";
      note.textContent = "8-bit visual difference (non-reference)";
      comparisonParameters.append(note);
    }
  };

  const prepareCommit = (
    candidateCanvases: ReadonlyMap<ClipId, HTMLCanvasElement>,
  ): (() => void) => {
    const next = state;
    let stagedComparison: HTMLCanvasElement | undefined;
    let comparisonLabel = "";
    if (ALIGNED_MODES.has(next.mode)) {
      const secondary = next.secondary;
      if (secondary === undefined) {
        throw new Error("Aligned comparison clips are unavailable.");
      }
      const first = candidateCanvases.get(next.primary);
      const second = candidateCanvases.get(secondary);
      if (first === undefined || second === undefined) {
        throw new Error("Aligned comparison frames are unavailable.");
      }

      stagedComparison = stagingComparisonCanvas;
      stagedComparison.width = first.width;
      stagedComparison.height = first.height;
      const context = stagedComparison.getContext("2d");
      if (context === null) {
        throw new Error("The comparison canvas is unavailable.");
      }
      context.clearRect(0, 0, stagedComparison.width, stagedComparison.height);
      context.drawImage(first, 0, 0, stagedComparison.width, stagedComparison.height);
      if (next.mode === "wipe") {
        context.save();
        context.beginPath();
        context.rect(
          0,
          0,
          stagedComparison.width * next.wipePosition,
          stagedComparison.height,
        );
        context.clip();
        context.drawImage(
          second,
          0,
          0,
          stagedComparison.width,
          stagedComparison.height,
        );
        context.restore();
      } else if (next.mode === "overlay") {
        context.save();
        context.globalAlpha = next.overlayOpacity;
        context.drawImage(
          second,
          0,
          0,
          stagedComparison.width,
          stagedComparison.height,
        );
        context.restore();
      } else {
        context.save();
        context.globalCompositeOperation = "difference";
        context.drawImage(
          second,
          0,
          0,
          stagedComparison.width,
          stagedComparison.height,
        );
        context.restore();
      }
      stagedComparison.setAttribute(
        "aria-label",
        `${clipForId(next.primary).label} and ${clipForId(secondary).label}, ${next.mode} comparison`,
      );
      comparisonLabel = `${clipForId(next.primary).label} (A) | ${clipForId(secondary).label} (B)`;
    }

    return () => {
      const previousState = committedState;
      const previousModeLabel = modeLabel.textContent;
      const previousMode = clips.dataset.mode;
      const previousHidden = comparison.hidden;
      const previousComparisonLabel = comparisonLabels.textContent;
      const previousCanvases = new Map(canvases);
      const previousRowChildren = new Map(
        Array.from(rows, ([clipId, row]) => [clipId, Array.from(row.childNodes)]),
      );
      const previousRowActive = new Map(
        Array.from(rows, ([clipId, row]) => [clipId, row.dataset.active]),
      );
      const previousCanvasVisibility = new Map(
        Array.from(canvases, ([clipId, canvas]) => [
          clipId,
          {
            hidden: canvas.hidden,
            ariaHidden: canvas.getAttribute("aria-hidden"),
          },
        ]),
      );
      try {
        const aligned = ALIGNED_MODES.has(next.mode);
        modeLabel.textContent = next.mode;
        clips.dataset.mode = next.mode;
        comparison.hidden = !aligned;
        comparisonLabels.textContent = aligned ? comparisonLabel : "";
        for (const clip of metadata.clips) {
          const row = rows.get(clip.id);
          if (row !== undefined) {
            updateClipRow(
              row,
              clip,
              next.activeClipIds.some((clipId) => idsMatch(clipId, clip.id)),
              aligned,
              canvases,
            );
          }
        }
        if (stagedComparison !== undefined) {
          comparisonCanvas.replaceWith(stagedComparison);
          stagingComparisonCanvas = comparisonCanvas;
          comparisonCanvas = stagedComparison;
        }
        committedState = next;
      } catch (error) {
        committedState = previousState;
        modeLabel.textContent = previousModeLabel;
        if (previousMode === undefined) {
          delete clips.dataset.mode;
        } else {
          clips.dataset.mode = previousMode;
        }
        comparison.hidden = previousHidden;
        comparisonLabels.textContent = previousComparisonLabel;
        canvases.clear();
        for (const [clipId, canvas] of previousCanvases) {
          canvases.set(clipId, canvas);
        }
        for (const [clipId, children] of previousRowChildren) {
          const row = rows.get(clipId);
          row?.replaceChildren(...children);
          const active = previousRowActive.get(clipId);
          if (row !== undefined) {
            if (active === undefined) {
              delete row.dataset.active;
            } else {
              row.dataset.active = active;
            }
          }
        }
        for (const [clipId, visibility] of previousCanvasVisibility) {
          const canvas = previousCanvases.get(clipId);
          if (canvas !== undefined) {
            canvas.hidden = visibility.hidden;
            if (visibility.ariaHidden === null) {
              canvas.removeAttribute("aria-hidden");
            } else {
              canvas.setAttribute("aria-hidden", visibility.ariaHidden);
            }
          }
        }
        throw error;
      }
    };
  };

  const compose = (): void => {
    state = committedState;
    prepareCommit(canvases)();
  };

  const setState = (
    next: ComparisonState,
    deferComposition = false,
  ): void => {
    const structuralChange =
      next.mode !== state.mode ||
      next.activeClipIds.length !== state.activeClipIds.length ||
      next.activeClipIds.some(
        (clipId, index) => !idsMatch(clipId, state.activeClipIds[index]),
      );
    state = next;
    for (const [value, button] of modeButtons) {
      button.setAttribute("aria-pressed", String(value === state.mode));
    }

    if (structuralChange) {
      renderSelectionControls();
      renderComparisonParameters();
    } else if (state.mode === "wipe") {
      const wipe = comparisonStage.querySelector<HTMLInputElement>(
        "input[aria-label='Wipe position']",
      );
      if (wipe !== null) {
        wipe.value = String(Math.round(state.wipePosition * 100));
      }
    } else if (state.mode === "overlay") {
      const opacity = comparisonParameters.querySelector<HTMLInputElement>(
        "input[aria-label='Overlay opacity']",
      );
      const output = comparisonParameters.querySelector("output");
      if (opacity !== null) {
        opacity.value = String(state.overlayOpacity);
      }
      if (output !== null) {
        output.textContent = `${Math.round(state.overlayOpacity * 100)}%`;
      }
    }
    if (!deferComposition) {
      prepareCommit(canvases)();
    }
  };

  renderSelectionControls();
  renderComparisonParameters();
  setState(state);
  return {
    toolbar,
    view: comparison,
    compose,
    prepareCommit,
    setState,
  };
}