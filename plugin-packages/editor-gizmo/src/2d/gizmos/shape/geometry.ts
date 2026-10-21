import type { GizmoActionEvent } from '../../gizmo-action';
import { Vector2 } from '../../math';

/** Geometry is expressed in the host's local editing plane, with Y pointing up. */
export interface PathPoint { x: number, y: number }
export interface PathIndex { point: number, easingIn: number, easingOut: number }
export interface PenPathData {
  points: PathPoint[],
  easingIns: PathPoint[],
  easingOuts: PathPoint[],
  shapes: Array<{ close: boolean, indexes: PathIndex[] }>,
}
export type ShapePrimitive = 'rect' | 'ellipse' | 'polygon' | 'star';
export interface ShapeGeometry {
  shapeType: ShapePrimitive,
  center: PathPoint,
  width: number,
  height: number,
}
export interface PenEditOperation {
  kind: 'point' | 'handle-in' | 'handle-out' | 'topology',
  index?: number,
}
export interface GeometryPathTarget {
  itemId: string,
  revision: unknown,
  path: PenPathData,
}

/** Hosts own units, time sampling and permissions. Conversions include parent/camera transforms. */
export interface GeometryGizmoHost {
  canEdit(itemId?: string): boolean,
  readPath(): GeometryPathTarget | undefined,
  viewToLocal(point: Vector2, itemId?: string): Vector2 | undefined,
  localToView(point: PathPoint, itemId?: string): Vector2,
  defaultShapeSize(type?: ShapePrimitive): [number, number],
  snapPoints?(itemId?: string): Vector2[],
  contextKey?(): unknown,
  deleteBehavior?: 'split' | 'reconnect',
  appendSubpaths?: boolean,
}

/** No document schema, paint, animation curve or history object crosses this boundary. */
export interface ShapeDrawingActionEvent extends GizmoActionEvent {
  sessionId: number,
  phase: 'start' | 'update' | 'commit' | 'cancel',
  create?: { kind: 'pen', path: PenPathData } | { kind: 'shape', geometry: ShapeGeometry },
  edit?: { itemId: string, before: PenPathData, path: PenPathData, operations: PenEditOperation[] },
  canceled?: boolean,
  finish?: boolean,
}

let sessionSequence = 0;
/** Allocate an interaction identity shared by all geometry tools. */
export function nextGeometrySession (): number { return ++sessionSequence; }

/** Isolate geometry from both the source document and event listeners. */
export function cloneGeometry<T> (value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

/** Preserve anchor indices so an animated host can update only the changed channels. */
export function penEditOperations (before: PenPathData, after: PenPathData): PenEditOperation[] {
  const operations: PenEditOperation[] = [];
  for (const [field, kind] of [['points', 'point'], ['easingIns', 'handle-in'], ['easingOuts', 'handle-out']] as const) {
    after[field].forEach((point, index) => {
      const previous = before[field][index];
      if (!previous || previous.x !== point.x || previous.y !== point.y) { operations.push({ kind, index }); }
    });
  }
  if (JSON.stringify(before.shapes) !== JSON.stringify(after.shapes)) { operations.push({ kind: 'topology' }); }
  return operations;
}

/** Conservative local bounds include both anchors and relative control handles. */
export function penPathBounds (path: PenPathData): { min: Vector2, max: Vector2 } {
  const min = new Vector2(Infinity, Infinity);
  const max = new Vector2(-Infinity, -Infinity);
  for (const shape of path.shapes) {
    for (const index of shape.indexes) {
      const point = path.points[index.point];
      if (!point) { continue; }
      for (const handle of [{ x: 0, y: 0 }, path.easingIns[index.easingIn], path.easingOuts[index.easingOut]]) {
        if (!handle) { continue; }
        min.x = Math.min(min.x, point.x + handle.x); min.y = Math.min(min.y, point.y + handle.y);
        max.x = Math.max(max.x, point.x + handle.x); max.y = Math.max(max.y, point.y + handle.y);
      }
    }
  }
  if (!Number.isFinite(min.x)) { min.set(0, 0); max.set(0, 0); }
  return { min, max };
}

/** Delete references without compacting point arrays or changing animation channel identities. */
export function deletePenPoint (path: PenPathData, shapeIndex: number, index: number, behavior: 'split' | 'reconnect'): void {
  const shape = path.shapes[shapeIndex];
  const anchor = shape?.indexes[index]?.point;
  if (anchor === undefined) { return; }
  if (behavior === 'reconnect') {
    shape.indexes.splice(index, 1);
    if (shape.indexes.length < 2) { path.shapes.splice(shapeIndex, 1); }
    return;
  }
  path.shapes = path.shapes.flatMap(current => {
    if (!current.indexes.some(value => value.point === anchor)) { return [current]; }
    const nodes = [...current.indexes];
    if (current.close) {
      const first = nodes.findIndex(value => value.point === anchor);
      nodes.push(...nodes.splice(0, first + 1));
    }
    const segments: typeof path.shapes = [];
    let indexes: PathIndex[] = [];
    for (const node of nodes) {
      if (node.point === anchor) {
        if (indexes.length) { segments.push({ ...current, close: false, indexes }); }
        indexes = [];
      } else { indexes.push(node); }
    }
    if (indexes.length) { segments.push({ ...current, close: false, indexes }); }
    return segments;
  });
}
