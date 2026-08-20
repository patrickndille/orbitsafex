/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        space: {
          950: "#020712",
          900: "#050d1a",
          800: "#0a1628",
          700: "#0f2040",
          600: "#152a52",
        },
        risk: {
          critical: "#ef4444",
          high: "#f97316",
          elevated: "#eab308",
          monitor: "#22c55e",
        },
      },
      fontFamily: {
        mono: ["JetBrains Mono", "Fira Code", "monospace"],
      },
    },
  },
  plugins: [],
};
