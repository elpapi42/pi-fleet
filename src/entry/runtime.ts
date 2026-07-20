import { PRODUCT_BINARY } from "../shared/product-identity.js";

export function runRuntime(): number {
  process.stderr.write(`${PRODUCT_BINARY} runtime is not implemented yet.\n`);
  return 1;
}

if (process.argv[1] !== undefined && import.meta.url.endsWith("/runtime.mjs")) {
  process.exitCode = runRuntime();
}
