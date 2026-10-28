"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const runner = require("../../backend/api/test/run-integration-isolated");
test("Jest JSON rejects every pending, skipped, disabled, or todo selected test", () => {
  for (const status of ["pending", "disabled", "todo"]) {
    assert.throws(
      () =>
        runner.assertNoIncompleteTests(
          {
            numPendingTests: 1,
            testResults: [
              {
                testFilePath: "/selected.integration-spec.ts",
                numPendingTests: 1,
                assertionResults: [{ status, fullName: `selected ${status}` }],
              },
            ],
          },
          "/selected.integration-spec.ts",
        ),
      /skipped\/pending\/todo/,
    );
  }
  assert.doesNotThrow(() =>
    runner.assertNoIncompleteTests(
      {
        numPendingTests: 0,
        testResults: [
          { numPendingTests: 0, assertionResults: [{ status: "passed" }] },
        ],
      },
      "/selected.integration-spec.ts",
    ),
  );
});

test("discovery delegates selection to Jest and rejects zero or duplicate suites", () => {
  const calls = [];
  const spawn = (...args) => {
    calls.push(args);
    return {
      status: 0,
      stdout: JSON.stringify(["/tmp/a.integration-spec.ts"]),
      stderr: "",
    };
  };
  assert.deepEqual(runner.discoverSuites(["--runInBand"], "/repo", spawn), [
    path.resolve("/tmp/a.integration-spec.ts"),
  ]);
  assert.ok(calls[0][1].includes("--listTests"));
  assert.ok(
    !calls[0][1]
      .slice(calls[0][1].indexOf("--json") + 1)
      .includes("--runInBand"),
  );
  assert.throws(
    () =>
      runner.discoverSuites([], "/repo", () => ({ status: 0, stdout: "[]" })),
    /zero/,
  );
  assert.throws(
    () =>
      runner.discoverSuites([], "/repo", () => ({
        status: 0,
        stdout: '["a","a"]',
      })),
    /duplicate/,
  );
});

test("database names are unique, safe, deterministic, and PostgreSQL-sized", () => {
  const first = runner.makeDatabaseName(
    "/very/".repeat(30) + "suite.integration-spec.ts",
    "abc123",
    0,
  );
  const second = runner.makeDatabaseName(
    "suite.integration-spec.ts",
    "abc123",
    1,
  );
  assert.match(first, /^[a-z][a-z0-9_]{0,62}$/);
  assert.notEqual(first, second);
  assert.equal(
    first,
    runner.makeDatabaseName(
      "/very/".repeat(30) + "suite.integration-spec.ts",
      "abc123",
      0,
    ),
  );
});

test("suite failure propagates after cleanup and subsequent selected suites still run", async () => {
  const events = [];
  const databases = new Set();
  const admin = {
    connect: async () => events.push("connect"),
    end: async () => events.push("end"),
    query: async (sql, values) => {
      if (sql.startsWith("CREATE")) databases.add(sql.match(/"([^"]+)"/)[1]);
      if (sql.startsWith("DROP")) databases.delete(sql.match(/"([^"]+)"/)[1]);
      if (sql.startsWith("SELECT 1"))
        return { rowCount: databases.has(values[0]) ? 1 : 0 };
      return { rowCount: 0 };
    },
  };
  await assert.rejects(
    () =>
      runner.run({
        args: [],
        admin,
        nonce: "unit",
        discover: () => ["/a.integration-spec.ts", "/b.integration-spec.ts"],
        flush: async () => events.push("flush"),
        runSuite: async (suite) => {
          events.push(suite);
          if (suite.startsWith("/a")) throw new Error("boom");
        },
      }),
    /1 integration suite/,
  );
  assert.deepEqual([...databases], []);
  assert.ok(events.includes("/b.integration-spec.ts"));
  assert.equal(events.at(-1), "end");
});

test("cleanup failure is fail-closed and connection is always ended", async () => {
  let ended = false;
  const admin = {
    connect: async () => {},
    end: async () => {
      ended = true;
    },
    query: async (sql) => {
      if (sql.startsWith("DROP")) throw new Error("cannot drop");
      return { rowCount: 0 };
    },
  };
  await assert.rejects(
    () =>
      runner.run({
        admin,
        nonce: "unit",
        discover: () => ["/a.integration-spec.ts"],
        flush: async () => {},
        runSuite: async () => {},
      }),
    /1 integration suite or cleanup/,
  );
  assert.equal(ended, true);
});
