import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Docker/self-host uses standalone; Vercel uses its own output pipeline
  ...(process.env.VERCEL ? {} : { output: "standalone" }),
  // Monorepo: include workspace root files in the standalone/trace
  outputFileTracingRoot: path.join(__dirname, "../.."),
  transpilePackages: ["@laptop-paas/shared"],
};

export default nextConfig;
