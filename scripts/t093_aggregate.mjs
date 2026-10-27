#!/usr/bin/env node
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [resultsDir, outputPath] = process.argv.slice(2);
if (!resultsDir || !outputPath)
  throw new Error("usage: t093_aggregate.mjs RESULTS_DIR OUTPUT_JSON");
const files = readdirSync(resultsDir)
  .filter((name) => name.endsWith(".json"))
  .sort();
if (!files.length) throw new Error("no per-suite Jest results found");
const suites = files.map((name) =>
  JSON.parse(readFileSync(join(resultsDir, name), "utf8")),
);
const totals = suites.reduce(
  (sum, result) => ({
    numTotalTestSuites: sum.numTotalTestSuites + result.numTotalTestSuites,
    numPassedTestSuites: sum.numPassedTestSuites + result.numPassedTestSuites,
    numFailedTestSuites: sum.numFailedTestSuites + result.numFailedTestSuites,
    numPendingTestSuites:
      sum.numPendingTestSuites + result.numPendingTestSuites,
    numTotalTests: sum.numTotalTests + result.numTotalTests,
    numPassedTests: sum.numPassedTests + result.numPassedTests,
    numFailedTests: sum.numFailedTests + result.numFailedTests,
    numPendingTests: sum.numPendingTests + result.numPendingTests,
  }),
  {
    numTotalTestSuites: 0,
    numPassedTestSuites: 0,
    numFailedTestSuites: 0,
    numPendingTestSuites: 0,
    numTotalTests: 0,
    numPassedTests: 0,
    numFailedTests: 0,
    numPendingTests: 0,
  },
);
writeFileSync(
  outputPath,
  `${JSON.stringify({ success: totals.numFailedTestSuites === 0, ...totals })}\n`,
);
