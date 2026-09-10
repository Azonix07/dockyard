/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  transpilePackages: ["@laptop-paas/shared"],
};

export default nextConfig;
