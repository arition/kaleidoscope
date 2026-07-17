import type { ClipId, ComparisonMode, PreviewMetadataMessage } from "./protocol.js";

export interface ComparisonState {
  readonly mode: ComparisonMode;
  readonly activeClipIds: ClipId[];
  readonly primary: ClipId;
  readonly secondary?: ClipId;
  readonly overlayOpacity: number;
  readonly wipePosition: number;
}

export interface ComparisonTransition {
  mode?: ComparisonMode;
  selectedClipIds?: ClipId[];
  primary?: ClipId;
  secondary?: ClipId;
  overlayOpacity?: number;
  wipePosition?: number;
}

export interface ComparisonTransitionResult {
  state: ComparisonState;
  requiresFrameSet: boolean;
}

const alignedModes = new Set<ComparisonMode>(["wipe", "overlay", "difference"]);

const idsEqual = (left: ClipId, right: ClipId): boolean => left === right;

const activeSetsEqual = (left: ClipId[], right: ClipId[]): boolean =>
  left.length === right.length && left.every((clipId, index) => idsEqual(clipId, right[index]));

const clipById = (metadata: PreviewMetadataMessage, clipId: ClipId) => {
  const clip = metadata.clips.find((candidate) => idsEqual(candidate.id, clipId));
  if (clip === undefined) {
    throw new Error(`Unknown clip ID ${String(clipId)}.`);
  }
  return clip;
};

const normalizeSelection = (metadata: PreviewMetadataMessage, requested: ClipId[]): ClipId[] => {
  const selected = new Set(requested);
  const normalized = metadata.clips.map((clip) => clip.id).filter((clipId) => selected.has(clipId));
  if (normalized.length !== selected.size) {
    throw new Error("The comparison selection contains an unknown clip.");
  }
  return normalized;
};

const resolvePair = (
  metadata: PreviewMetadataMessage,
  current: ComparisonState | undefined,
  primary: ClipId | undefined,
  secondary: ClipId | undefined,
): [ClipId, ClipId] => {
  let first = primary ?? current?.primary ?? metadata.clips[0].id;
  let firstClip = clipById(metadata, first);
  const compatible = (clipId: ClipId | undefined): clipId is ClipId => {
    if (clipId === undefined || idsEqual(first, clipId)) {
      return false;
    }
    const clip = clipById(metadata, clipId);
    return (
      firstClip.source_width === clip.source_width && firstClip.source_height === clip.source_height
    );
  };
  let second =
    secondary ??
    (compatible(current?.secondary)
      ? current.secondary
      : metadata.clips.find((clip) => compatible(clip.id))?.id);
  if (second === undefined && primary === undefined && secondary === undefined) {
    for (const candidate of metadata.clips) {
      const partner = metadata.clips.find(
        (clip) =>
          !idsEqual(clip.id, candidate.id) &&
          clip.source_width === candidate.source_width &&
          clip.source_height === candidate.source_height,
      );
      if (partner !== undefined) {
        first = candidate.id;
        firstClip = candidate;
        second = partner.id;
        break;
      }
    }
  }
  if (second === undefined || idsEqual(first, second)) {
    throw new Error("Aligned comparison clips must be distinct.");
  }
  const secondClip = clipById(metadata, second);
  if (
    firstClip.source_width !== secondClip.source_width ||
    firstClip.source_height !== secondClip.source_height
  ) {
    throw new Error("Aligned comparison clips require matching source dimensions.");
  }
  return [first, second];
};

export const createComparisonState = (metadata: PreviewMetadataMessage): ComparisonState => {
  const primary = metadata.active_clip_ids[0];
  const secondary = metadata.active_clip_ids[1];
  return {
    mode: metadata.mode,
    activeClipIds: [...metadata.active_clip_ids],
    primary,
    secondary,
    overlayOpacity: metadata.overlay_opacity,
    wipePosition: 0.5,
  };
};

export const transitionComparisonState = (
  current: ComparisonState,
  metadata: PreviewMetadataMessage,
  transition: ComparisonTransition,
): ComparisonTransitionResult => {
  const mode = transition.mode ?? current.mode;
  let primary = transition.primary ?? current.primary;
  let secondary = transition.secondary ?? current.secondary;
  let activeClipIds: ClipId[];

  if (mode === "single") {
    primary = transition.primary ?? transition.selectedClipIds?.[0] ?? primary;
    clipById(metadata, primary);
    secondary = undefined;
    activeClipIds = [primary];
  } else if (mode === "side-by-side") {
    const selected = transition.selectedClipIds ?? current.activeClipIds;
    activeClipIds = normalizeSelection(metadata, selected);
    if (activeClipIds.length === 0 || activeClipIds.length > metadata.max_visible_clips) {
      throw new Error(`Side-by-side comparison requires 1-${metadata.max_visible_clips} clips.`);
    }
    primary = activeClipIds[0];
    secondary = undefined;
  } else if (alignedModes.has(mode)) {
    if (metadata.max_visible_clips < 2) {
      throw new Error("Aligned comparison exceeds the configured visible-clip limit.");
    }
    [primary, secondary] = resolvePair(metadata, current, transition.primary, transition.secondary);
    activeClipIds = [primary, secondary];
  } else {
    throw new Error(`Unsupported comparison mode ${mode}.`);
  }

  const state: ComparisonState = {
    mode,
    activeClipIds,
    primary,
    secondary,
    overlayOpacity: Math.min(1, Math.max(0, transition.overlayOpacity ?? current.overlayOpacity)),
    wipePosition: Math.min(1, Math.max(0, transition.wipePosition ?? current.wipePosition)),
  };
  return {
    state,
    requiresFrameSet: !activeSetsEqual(current.activeClipIds, state.activeClipIds),
  };
};
