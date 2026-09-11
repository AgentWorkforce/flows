// Offline fixture: real providers must honor the kernel-issued idempotency key.
export async function execute(namespace, method, input, { idempotencyKey }) {
  return { namespace, method, metric: input.metric, value: 42, idempotencyKey };
}
