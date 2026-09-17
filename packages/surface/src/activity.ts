/** A duration in whole milliseconds or an unambiguous wall-clock literal. */
export type ActivityDuration = number | string;

/**
 * Opaque provider event preserved by the journal. Providers may add fields;
 * bodies must re-read provider state instead of treating this payload as truth.
 */
export interface EventFrame {
  readonly type: string;
  readonly payload?: unknown;
  readonly [field: string]: unknown;
}

export type Wake =
  | { readonly kind: "events"; readonly events: readonly EventFrame[]; readonly offset: number }
  | { readonly kind: "idle" }
  | { readonly kind: "deadline"; readonly pending: { readonly from: number; readonly to: number } | null }
  | { readonly kind: "overflow"; readonly retained: number; readonly bytes: number; readonly from: number };

/** Bounds are required so a body-level subscription cannot keep a run open forever. */
export interface ActivityOptions {
  /** Coalesce a burst until this long after its most recent frame. Defaults to zero. */
  readonly settle?: ActivityDuration;
  /** Per wake: return idle after this long without a buffered matching frame. */
  readonly idle: ActivityDuration;
  /** Absolute cap fixed when the subscription is opened. */
  readonly deadline: ActivityDuration;
  /** Include events caused by the run identity. Defaults to false. */
  readonly includeSelf?: boolean;
}

/** A durable, bounded cursor over matching provider events. */
export interface Activity {
  next(): Promise<Wake>;
  close(): Promise<void>;
}
