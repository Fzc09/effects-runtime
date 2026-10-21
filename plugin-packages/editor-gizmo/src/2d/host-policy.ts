import type { Engine, VFXItem } from '@galacean/effects';
import type { GizmoOwner } from './gizmo-owner';
import type { GeometryGizmoHost } from './gizmos/shape/geometry';

/** Optional host restrictions. Omitted options preserve the standalone editor behavior. */
export interface GizmoHostPolicy {
  /** Supply document coordinates and sampled geometry to the shared pen and shape tools. */
  geometryHost?: (owner: GizmoOwner) => GeometryGizmoHost,
  /** Optional local rectangle for non-rendered editor nodes; undefined keeps default geometry. */
  itemGeometry?: (item: VFXItem) => GizmoItemGeometry | undefined,
  /** Apply to clicks, hover, marquee selection and externally supplied IDs. */
  isSelectable?: (item: VFXItem) => boolean,
  /** Called before a transform starts; the host can reject incompatible selections. */
  canTransform?: (items: readonly VFXItem[]) => boolean,
  /** Allow moving items between frames and applying automatic layout. */
  assistedLayout?: boolean,
  /** Optional composition bounds in CSS canvas pixels: left, top, width, height. */
  viewportBounds?: () => readonly [number, number, number, number] | undefined,
  /** Allow double click to enter text, crop and other specialized editing modes. */
  specializedEditing?: boolean,
  /** Emit transform snapshots and allow cancellation without a business-data write. */
  transactionalTransforms?: boolean,
}

/** Local runtime transform, independent of the host's document representation. */
export interface GizmoTransformSnapshot {
  readonly id: string,
  readonly position: readonly [number, number, number],
  /** Effects Euler angles, in degrees. */
  readonly rotation: readonly [number, number, number],
  readonly quaternion: readonly [number, number, number, number],
  readonly scale: readonly [number, number, number],
}

/** A single pointer operation. The ID is unique within a GestureHandler lifetime. */
export interface GizmoTransformSessionEvent {
  readonly sessionId: number,
  readonly before: readonly GizmoTransformSnapshot[],
  readonly after: readonly GizmoTransformSnapshot[],
  readonly reason?: string,
}

/** Freeze a runtime transform before handing it to external listeners. */
export function snapshotGizmoTransform (item: VFXItem): GizmoTransformSnapshot {
  const { position: p, rotation: r, quat: q, scale: s } = item.transform;

  return Object.freeze({
    id: item.getInstanceId(),
    position: Object.freeze([p.x, p.y, p.z] as const),
    rotation: Object.freeze([r.x, r.y, r.z] as const),
    quaternion: Object.freeze([q.x, q.y, q.z, q.w] as const),
    scale: Object.freeze([s.x, s.y, s.z] as const),
  });
}

/** Restore a cancelled preview through Transform's invalidating setters. */
export function restoreGizmoTransform (item: VFXItem, snapshot: GizmoTransformSnapshot): void {
  item.transform.setPosition(...snapshot.position);
  item.transform.setQuaternion(...snapshot.quaternion);
  item.transform.setScale(...snapshot.scale);
}

/** A local-space rectangle; union with descendants is explicit, never implied. */
export interface GizmoItemGeometry {
  readonly min: readonly [number, number],
  readonly max: readonly [number, number],
  readonly includeChildren?: boolean,
}

const geometryProviders = new WeakMap<Engine, NonNullable<GizmoHostPolicy['itemGeometry']>>();

/** Install geometry for one engine and release only this registration. */
export function registerItemGeometry (engine: Engine, provider: NonNullable<GizmoHostPolicy['itemGeometry']>): () => void {
  if (geometryProviders.has(engine)) { throw new Error('An editor geometry provider is already registered for this engine.'); }
  geometryProviders.set(engine, provider);

  return () => { if (geometryProviders.get(engine) === provider) { geometryProviders.delete(engine); } };
}

/** Resolve the host geometry without leaking policies between Player instances. */
export function getHostItemGeometry (item: VFXItem): GizmoItemGeometry | undefined {
  return geometryProviders.get(item.engine)?.(item);
}
