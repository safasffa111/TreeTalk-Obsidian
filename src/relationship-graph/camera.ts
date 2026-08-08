export interface RelationshipGraphCamera {
  scale: number;
  panX: number;
  panY: number;
}

export interface RelationshipGraphPoint { x: number; y: number; }

export const RELATIONSHIP_GRAPH_MIN_SCALE = 0.35;
export const RELATIONSHIP_GRAPH_MAX_SCALE = 2.4;
export const RELATIONSHIP_GRAPH_LABEL_FADE_START = 0.78;
export const RELATIONSHIP_GRAPH_LABEL_FADE_END = 1.18;
export const RELATIONSHIP_GRAPH_LABEL_SCALE = RELATIONSHIP_GRAPH_LABEL_FADE_START;
export const RELATIONSHIP_GRAPH_WHEEL_SENSITIVITY = 0.00135;

export function clampRelationshipGraphScale(scale: number): number {
  return Math.max(RELATIONSHIP_GRAPH_MIN_SCALE, Math.min(RELATIONSHIP_GRAPH_MAX_SCALE, scale));
}

export function relationshipGraphLabelAlpha(scale: number): number {
  if (scale <= RELATIONSHIP_GRAPH_LABEL_FADE_START) return 0;
  if (scale >= RELATIONSHIP_GRAPH_LABEL_FADE_END) return 1;
  const normalized =
    (scale - RELATIONSHIP_GRAPH_LABEL_FADE_START) /
    (RELATIONSHIP_GRAPH_LABEL_FADE_END - RELATIONSHIP_GRAPH_LABEL_FADE_START);
  return normalized * normalized * (3 - 2 * normalized);
}

export function shouldShowRelationshipGraphLabels(scale: number): boolean {
  return relationshipGraphLabelAlpha(scale) > 0;
}

export function nextRelationshipGraphWheelScale(currentScale: number, deltaY: number): number {
  const normalized = Math.max(-120, Math.min(120, deltaY));
  return clampRelationshipGraphScale(currentScale * Math.exp(-normalized * RELATIONSHIP_GRAPH_WHEEL_SENSITIVITY));
}

export function zoomRelationshipGraphAtPoint(
  camera: RelationshipGraphCamera,
  pointer: RelationshipGraphPoint,
  requestedScale: number
): RelationshipGraphCamera {
  const nextScale = clampRelationshipGraphScale(requestedScale);
  const safeScale = clampRelationshipGraphScale(camera.scale);
  const worldX = (pointer.x - camera.panX) / safeScale;
  const worldY = (pointer.y - camera.panY) / safeScale;
  return {
    scale: nextScale,
    panX: pointer.x - worldX * nextScale,
    panY: pointer.y - worldY * nextScale
  };
}

export function stepRelationshipGraphCamera(
  display: RelationshipGraphCamera,
  target: RelationshipGraphCamera,
  deltaMs: number
): RelationshipGraphCamera {
  const elapsed = Math.max(0, Number.isFinite(deltaMs) ? deltaMs : 0);
  const amount = 1 - Math.exp(-elapsed / 55);
  return {
    scale: display.scale + (target.scale - display.scale) * amount,
    panX: display.panX + (target.panX - display.panX) * amount,
    panY: display.panY + (target.panY - display.panY) * amount
  };
}

export function relationshipGraphCameraSettled(
  display: RelationshipGraphCamera,
  target: RelationshipGraphCamera
): boolean {
  return (
    Math.abs(display.scale - target.scale) < 0.0001 &&
    Math.abs(display.panX - target.panX) < 0.01 &&
    Math.abs(display.panY - target.panY) < 0.01
  );
}
