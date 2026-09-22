/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  // Several lockfiles exist above this directory; pin the trace root to this app.
  outputFileTracingRoot: new URL(".", import.meta.url).pathname,
};
