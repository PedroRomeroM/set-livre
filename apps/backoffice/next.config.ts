import type { NextConfig } from "next";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const securityHeaders = [
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
] satisfies Array<{ key: string; value: string }>;

const nextConfig: NextConfig = {
  agentRules: false,
  devIndicators: process.env.APP_ENV === "test" ? false : { position: "bottom-left" },
  generateBuildId: async () => process.env.APP_RELEASE_SHA ?? "local",
  output: "standalone",
  outputFileTracingRoot: repositoryRoot,
  poweredByHeader: false,
  reactStrictMode: true,
  serverExternalPackages: ["pg"],
  transpilePackages: ["@set-livre/contracts", "@set-livre/ui"],
  typedRoutes: true,
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default nextConfig;
