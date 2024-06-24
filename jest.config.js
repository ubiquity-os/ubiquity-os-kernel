// jest.config.js
/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: "node",
  roots: ["./tests"],
  coveragePathIgnorePatterns: ["node_modules", "mocks"],
  collectCoverage: true,
  coverageReporters: ["json", "lcov", "text", "clover", "json-summary"],
  reporters: ["default", "jest-junit"],
  coverageDirectory: "coverage",
  verbose: true,
  transformIgnorePatterns: [],
  transform: {
    "^.+\\.[j|t]s$": "@swc/jest",
  },
  moduleNameMapper: {
    "@octokit/webhooks-methods": "<rootDir>/node_modules/@octokit/webhooks-methods/dist-node/index.js",
  },
};
