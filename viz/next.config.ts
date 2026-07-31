import type { NextConfig } from "next";

/**
 * Static export is opt-in via TRAFFICLAB_STATIC=1 (see scripts/build_web.mjs).
 * Leaving it off by default keeps `npm run dev` and `npm run build` behaving
 * exactly as they did for the research tool — only the public demo build needs
 * a pre-rendered, server-less bundle.
 */
const staticExport = process.env.TRAFFICLAB_STATIC === "1";
/**
 * GitHub Pages serves a project site under /<repo>/, so the bundle needs that
 * prefix baked in. Runtime fetches (the .traj fixtures) are not rewritten by
 * Next, hence NEXT_PUBLIC_BASE_PATH — see src/lib/demo/story.ts.
 */
const basePath = process.env.TRAFFICLAB_BASE_PATH ?? "";

const nextConfig: NextConfig = staticExport
  ? {
      output: "export",
      images: { unoptimized: true },
      ...(basePath ? { basePath, assetPrefix: basePath } : {}),
      env: { NEXT_PUBLIC_BASE_PATH: basePath },
    }
  : {};

export default nextConfig;
