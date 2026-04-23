import type { Metadata, Viewport } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";

export const metadata: Metadata = {
  title: "tik-test review — swipe through open PRs",
  description:
    "TikTok-style review feed for every open pull request. Watch a 45-second walk-through, drop a pill reaction, approve or request changes — GitHub review, zero backend.",
  icons: { icon: "/icon.svg" },
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "tik-test" },
  other: { "mobile-web-app-capable": "yes" },
};

// Lock zoom + extend into the safe area so the video canvas is edge-to-edge.
// Pinch-zoom on the feed was landing on an awkward scroll state; a proper
// app-style viewport is the right fix.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: "#0a0b0f",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      style={{
        ["--font-sans" as any]: GeistSans.style.fontFamily,
        ["--font-mono" as any]: GeistMono.style.fontFamily,
      }}
      className={`${GeistSans.variable} ${GeistMono.variable}`}
    >
      <body className="min-h-screen bg-background font-sans text-foreground overscroll-none [touch-action:manipulation] [-webkit-text-size-adjust:100%]">{children}</body>
    </html>
  );
}
