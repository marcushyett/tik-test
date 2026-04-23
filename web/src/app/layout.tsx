import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";

export const metadata: Metadata = {
  title: "tik-test review — swipe through open PRs",
  description:
    "TikTok-style review feed for every open pull request. Watch a 45-second walk-through, drop a pill reaction, approve or request changes — GitHub review, zero backend.",
  icons: { icon: "/icon.svg" },
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
      <body className="min-h-screen bg-background font-sans text-foreground">{children}</body>
    </html>
  );
}
