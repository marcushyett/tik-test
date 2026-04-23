import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "tik-test review",
  description: "TikTok-style review feed for your open PRs. Swipe, react, ship.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen bg-background text-foreground">
        <div className="mx-auto flex min-h-screen max-w-5xl flex-col">{children}</div>
      </body>
    </html>
  );
}
