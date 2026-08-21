/** @type {import('jest').Config} */
const config = {
  testEnvironment: "jsdom",
  transform: {
    "^.+\\.(ts|tsx)$": ["ts-jest", { tsconfig: { jsx: "react-jsx" } }],
  },
  moduleNameMapper: {
    // Path aliases from tsconfig
    "^@/(.*)$": "<rootDir>/src/$1",
    // Stub CSS modules and static assets
    "\\.(css|less|scss|sass)$": "<rootDir>/src/__mocks__/fileMock.js",
    // Stub Three.js and lucide to avoid ESM issues in jsdom
    "^three$": "<rootDir>/src/__mocks__/three.js",
    "^lucide-react$": "<rootDir>/src/__mocks__/lucide-react.js",
  },
  setupFilesAfterEnv: ["<rootDir>/src/setupTests.ts"],
  testMatch: ["**/__tests__/**/*.{ts,tsx}", "**/*.test.{ts,tsx}"],
  testPathIgnorePatterns: ["/node_modules/", "/.next/"],
};

module.exports = config;
