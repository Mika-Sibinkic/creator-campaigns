import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // Pin workspace root to this dashboard dir. A stray package.json in the
  // user's home directory was causing Next.js to infer the wrong workspace
  // root, which triggered a browserslist crash ("Cannot set properties of
  // undefined (setting 'esr')") on dev startup.
  turbopack: {
    root: path.resolve(__dirname),
  },
  outputFileTracingRoot: path.resolve(__dirname),
};

export default nextConfig;
