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
        {/* KaTeX CSS — required for rehype-katex math rendering */}
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css"
          integrity="sha384-nB0miv6/jRmo5UMMR1wu3Gz6NLsoTkbqJghGIsx//Rlm+ZU03BU6SQNC66uf4l5"
          crossOrigin="anonymous"
        />
      </head>
      <body className="antialiased">{children}</body>
    </html>
  );
}
