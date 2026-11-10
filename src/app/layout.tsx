import type { Metadata } from "next";
import { Inter } from "next/font/google";
import type { ReactNode } from "react";

import "./globals.css";

// Self-hosted by Next at build time; no font request leaves the browser at runtime.
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

export const metadata: Metadata = {
  title: "Restaurant Operations Management System",
  description: "Restaurant operations for dining room, bar, and takeout.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="bg-canvas font-sans text-neutral-900 antialiased">{children}</body>
    </html>
  );
}
