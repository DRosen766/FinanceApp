import type { NextConfig } from "next";

// Cache Components is intentionally OFF: every page here is per-request, authenticated,
// financial data that must never be prerendered or cached. The CSP (with a per-request
// nonce) is set in src/proxy.ts; static security headers are set here.
const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/((?!_next/static).*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "no-store" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
