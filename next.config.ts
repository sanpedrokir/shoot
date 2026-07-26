import type { NextConfig } from "next";

// Baked into every bundle (client and server) at build time -- the client
// compares its own copy against /api/version's live server-side read of the
// same value to detect "a new deploy has shipped since this page loaded"
// without needing any external versioning service.
const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_BUILD_ID: String(Date.now()),
  },
};

export default nextConfig;
