const OBJECT_DEFINE_PROPERTY = Object.defineProperty;

/** Append without consulting an inherited numeric setter on Array.prototype. */
export function appendIntrinsicArray<T>(array: T[], ...values: T[]): number {
  for (let index = 0; index < values.length; index += 1) {
    OBJECT_DEFINE_PROPERTY(array, array.length, {
      configurable: true,
      enumerable: true,
      value: values[index]!,
      writable: true,
    });
  }
  return array.length;
}
