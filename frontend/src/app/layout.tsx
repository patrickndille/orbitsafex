import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "OrbitSafe AI – Space Debris Conjunction Dashboard",
  description:
    "Real-time LEO conjunction analysis and AI-powered evasive maneuver triage powered by SGP4 orbital mechanics.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
      </head>
      <body className="antialiased">{children}</body>
    </html>
  );
}
