import type { Metadata, Viewport } from "next";
import { Archivo, Instrument_Sans } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";
import { APP } from "@/lib/core/config";

/**
 * Two variable families, no more. Archivo carries a `wdth` axis, which is what
 * gives the display type its broadcast-scoreboard width — see DESIGN.md.
 */
const archivo = Archivo({
  subsets: ["latin"],
  variable: "--font-archivo",
  axes: ["wdth"],
  display: "swap",
});

const instrument = Instrument_Sans({
  subsets: ["latin"],
  variable: "--font-instrument",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: `${APP.name} — ${APP.tagline}`,
    template: `%s · ${APP.name}`,
  },
  description:
    "Live music and film charts from Apple Music, YouTube, TMDB and more. " +
    "What's in cinemas, what's on streaming, and what's coming — in one page.",
  applicationName: APP.name,
  creator: APP.brand,
  authors: [{ name: APP.brand, url: APP.instagramUrl }],
  // Tells Instagram/X which account to credit when the link is shared.
  other: { "instagram:creator": APP.brand },
  openGraph: {
    title: `${APP.name} — ${APP.tagline}`,
    description:
      "Live music and film charts, in cinemas and on streaming, in one page.",
    siteName: APP.name,
    type: "website",
  },
  twitter: { card: "summary_large_image", creator: APP.brand },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: "#0b0221",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${archivo.variable} ${instrument.variable}`}>
      <body>
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
