import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  // Several lockfiles exist above this directory, so pin the trace root to this app.
  // Must go through fileURLToPath: URL.pathname yields "/C:/Users/..." on Windows,
  // which Next 16 rejects as an invalid path.
  outputFileTracingRoot: dirname(fileURLToPath(import.meta.url)),
};
