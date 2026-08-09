import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // There are lockfiles further up this tree from unrelated projects; pin the
  // workspace root so Turbopack doesn't infer the wrong one.
  turbopack: { root: __dirname },

  /**
   * Lets a phone on the same Wi-Fi open the dev server at http://<lan-ip>:3000.
   *
   * Next blocks cross-origin requests to dev-only assets by default, so without
   * this the page loads but HMR and some dev assets are refused — which shows up
   * as a page that renders once and then stops updating.
   *
   * DEVELOPMENT ONLY — Next ignores this in production builds. The ranges are
   * private, non-routable address space, so this cannot expose the dev server
   * beyond the local network.
   */
  allowedDevOrigins: [
    "192.168.1.5", // this Mac's current LAN address — changes if DHCP moves it
    "192.168.*.*",
    "10.*.*.*",
    "172.16.*.*",
  ],

  images: {
    /**
     * Every host we serve artwork from. This is an allowlist, so a source that
     * starts returning images from a new CDN fails visibly rather than
     * silently proxying arbitrary remote content.
     */
    remotePatterns: [
      // TMDB posters, backdrops, person profiles
      { protocol: "https", hostname: "image.tmdb.org", pathname: "/t/p/**" },
      // Apple Music / iTunes artwork
      { protocol: "https", hostname: "*.mzstatic.com" },
      // YouTube thumbnails
      { protocol: "https", hostname: "i.ytimg.com" },
      // Deezer artwork
      { protocol: "https", hostname: "cdn-images.dzcdn.net" },
      { protocol: "https", hostname: "e-cdns-images.dzcdn.net" },
      // Last.fm artwork
      { protocol: "https", hostname: "lastfm.freetls.fastly.net" },
    ],
    // Poster rails are dense; these are the widths the cards actually request.
    deviceSizes: [360, 480, 640, 828, 1080, 1280, 1920],
    imageSizes: [64, 96, 128, 164, 185, 256, 320],
  },

  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // We link out constantly; deny framing of our own pages.
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
