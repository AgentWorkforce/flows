import { PluginError, type PluginFailureKind } from './plugin-manifest.js';

const OBJECT_DEFINE_PROPERTY = Object.defineProperty;
const OBJECT_FREEZE = Object.freeze;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const OBJECT_PROTOTYPE = Object.prototype;

/**
 * Promise resolution reads a returned object's inherited `then` property.
 * Authored code runs in this process before the hosted boundary, so refuse
 * before the first await if it has made every ordinary object thenable.
 */
export function assertHostedPromiseSafety(
  code: PluginFailureKind,
  message = 'Hosted isolation refuses an ambient Object.prototype.then.',
): void {
  if (OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(OBJECT_PROTOTYPE, 'then') !== undefined) {
    throw new PluginError(code, message);
  }
}

/** Shadow inherited thenables before an object is used to settle a promise. */
export function hostedPromiseValue<T extends object>(value: T): T {
  OBJECT_DEFINE_PROPERTY(value, 'then', {
    configurable: false,
    enumerable: false,
    value: undefined,
    writable: false,
  });
  return value;
}

/** Freeze a behavior-free object after shadowing inherited thenables. */
export function frozenHostedPromiseValue<T extends object>(value: T): Readonly<T> {
  return OBJECT_FREEZE(hostedPromiseValue(value));
}
