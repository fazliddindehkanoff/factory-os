import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // pglite is in-process WASM (CPU-bound); running test files in parallel thrashes
    // the CPU and causes spurious timeouts. Run files sequentially with a generous budget.
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
