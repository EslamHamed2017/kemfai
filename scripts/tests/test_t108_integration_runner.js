"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
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

test("runner flushes the same isolated Redis database that Jest consumes", async () => {
  const flushed = [];
  const childUrls = [];
  const admin = {
    connect: async () => {},
    end: async () => {},
    query: async () => ({ rowCount: 0 }),
  };
  await runner.run({
    admin,
    env: { ...process.env, REDIS_URL: "redis://127.0.0.1:6379/0" },
    nonce: "redis_db",
    discover: () => ["/redis.integration-spec.ts"],
    flush: async (url) => flushed.push(url),
    runSuite: async (_suite, _database, _args, _cwd, env) =>
      childUrls.push(env.REDIS_URL),
  });
  assert.deepEqual(flushed, ["redis://127.0.0.1:6379/14"]);
  assert.deepEqual(childUrls, flushed);
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


test("runner-owned JSON flags never reach child Jest and conflicting output files fail closed", () => {
  assert.deepEqual(
    runner.parseRunnerArgs([
      "--runInBand",
      "--json",
      "--outputFile=/tmp/aggregate.json",
      "--runTestsByPath",
      "/a.integration-spec.ts",
    ]),
    {
      outputFile: "/tmp/aggregate.json",
      passthrough: ["--runInBand", "--runTestsByPath", "/a.integration-spec.ts"],
    },
  );
  assert.deepEqual(runner.parseRunnerArgs(["--outputFile", "relative.json"]), {
    outputFile: "relative.json",
    passthrough: [],
  });
  assert.throws(
    () => runner.parseRunnerArgs(["--outputFile=a.json", "--outputFile=b.json"]),
    /Multiple Jest output files/,
  );
  assert.throws(() => runner.parseRunnerArgs(["--json"]), /requires --outputFile/);
});

test("child Jest args preserve two-token option values but remove multi-suite selectors", () => {
  const cwd = "/repo/backend/api";
  const suites = [
    "/repo/backend/api/test/integration/a.integration-spec.ts",
    "/repo/backend/api/test/integration/b.integration-spec.ts",
  ];
  assert.deepEqual(
    runner.childJestArgs(
      [
        "--runInBand",
        "--testNamePattern",
        "grant and expiry",
        "--runTestsByPath",
        "test/integration/a.integration-spec.ts",
        "test/integration/b.integration-spec.ts",
      ],
    ),
    ["--runInBand", "--testNamePattern", "grant and expiry"],
  );
  assert.deepEqual(
    runner.childJestArgs([
      "--testNamePattern",
      "/repo/backend/api/test/integration/a.integration-spec.ts",
      "--runTestsByPath",
      "test/integration/a.integration-spec.ts",
    ]),
    ["--testNamePattern", "/repo/backend/api/test/integration/a.integration-spec.ts"],
  );
  assert.deepEqual(
    runner.childJestArgs(
      [
        "--runInBand",
        "test/integration/a.integration-spec.ts",
        "test/integration/b.integration-spec.ts",
        "--testNamePattern",
        "/repo/backend/api/test/integration/a.integration-spec.ts",
      ],
      suites,
      cwd,
    ),
    [
      "--runInBand",
      "--testNamePattern",
      "/repo/backend/api/test/integration/a.integration-spec.ts",
    ],
  );
});

test("isolated suite JSON is aggregated with exact Jest counts and spec names", () => {
  const make = (name, tests) => ({
    success: true,
    wasInterrupted: false,
    startTime: 100,
    numFailedTestSuites: 0,
    numFailedTests: 0,
    numPassedTestSuites: 1,
    numPassedTests: tests,
    numPendingTestSuites: 0,
    numPendingTests: 0,
    numRuntimeErrorTestSuites: 0,
    numTodoTests: 0,
    numTotalTestSuites: 1,
    numTotalTests: tests,
    testResults: [{ name, assertionResults: [] }],
  });
  const merged = runner.mergeJestResults([
    make("/repo/a.integration-spec.ts", 59),
    make("/repo/b.integration-spec.ts", 7),
    make("/repo/c.integration-spec.ts", 11),
  ]);
  assert.equal(merged.success, true);
  assert.equal(merged.wasInterrupted, false);
  assert.equal(merged.numTotalTestSuites, 3);
  assert.equal(merged.numPassedTestSuites, 3);
  assert.equal(merged.numTotalTests, 77);
  assert.equal(merged.numPassedTests, 77);
  assert.deepEqual(
    merged.testResults.map((result) => result.name),
    ["/repo/a.integration-spec.ts", "/repo/b.integration-spec.ts", "/repo/c.integration-spec.ts"],
  );
});


test("concurrent writers to one output file fail closed under an exclusive lock", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kemfai-runner-lock-"));
  const output = path.join(directory, "aggregate.json");
  const databases = new Set();
  const admin = () => ({
    connect: async () => {},
    end: async () => {},
    query: async (sql, values) => {
      if (sql.startsWith("CREATE")) databases.add(sql.match(/"([^"]+)"/)[1]);
      if (sql.startsWith("DROP")) databases.delete(sql.match(/"([^"]+)"/)[1]);
      if (sql.startsWith("SELECT 1")) return { rowCount: databases.has(values[0]) ? 1 : 0 };
      return { rowCount: 0 };
    },
  });
  const result = {
    success: true,
    wasInterrupted: false,
    numPassedTestSuites: 1,
    numPassedTests: 1,
    numTotalTestSuites: 1,
    numTotalTests: 1,
    testResults: [{ name: "/held.integration-spec.ts", assertionResults: [] }],
  };
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });

  try {
    const first = runner.run({
      args: ["--json", `--outputFile=${output}`],
      admin: admin(),
      nonce: "lock_first",
      discover: () => ["/held.integration-spec.ts"],
      flush: async () => {},
      runSuite: async () => {
        await held;
        return result;
      },
    });
    while (!fs.existsSync(`${output}.lock`)) await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(
      () =>
        runner.run({
          args: ["--json", `--outputFile=${output}`],
          admin: admin(),
          nonce: "lock_second",
          discover: () => ["/second.integration-spec.ts"],
          flush: async () => {},
          runSuite: async () => {
            throw new Error("must never start");
          },
        }),
      /already in use/,
    );
    assert.equal(fs.existsSync(output), false);
    release();
    await first;
    assert.equal(JSON.parse(fs.readFileSync(output, "utf8")).numTotalTests, 1);
    assert.equal(fs.existsSync(`${output}.lock`), false);
  } finally {
    release?.();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("aggregate output replaces stale JSON on success and is absent after suite failure", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kemfai-runner-output-"));
  const output = path.join(directory, "aggregate.json");
  const databases = new Set();
  const admin = {
    connect: async () => {},
    end: async () => {},
    query: async (sql, values) => {
      if (sql.startsWith("CREATE")) databases.add(sql.match(/"([^"]+)"/)[1]);
      if (sql.startsWith("DROP")) databases.delete(sql.match(/"([^"]+)"/)[1]);
      if (sql.startsWith("SELECT 1")) return { rowCount: databases.has(values[0]) ? 1 : 0 };
      return { rowCount: 0 };
    },
  };
  const result = (name) => ({
    success: true,
    wasInterrupted: false,
    numFailedTestSuites: 0,
    numFailedTests: 0,
    numPassedTestSuites: 1,
    numPassedTests: 1,
    numPendingTestSuites: 0,
    numPendingTests: 0,
    numRuntimeErrorTestSuites: 0,
    numTodoTests: 0,
    numTotalTestSuites: 1,
    numTotalTests: 1,
    testResults: [{ name, assertionResults: [] }],
  });

  try {
    const victim = path.join(directory, "victim.txt");
    const predictableOldTemp = `${output}.tmp-${process.pid}`;
    fs.writeFileSync(victim, "SAFE");
    fs.symlinkSync(victim, predictableOldTemp);
    fs.writeFileSync(output, "stale");
    await runner.run({
      args: ["--json", `--outputFile=${output}`],
      admin,
      nonce: "output_success",
      discover: () => ["/a.integration-spec.ts", "/b.integration-spec.ts"],
      flush: async () => {},
      runSuite: async (suite) => result(suite),
    });
    const aggregate = JSON.parse(fs.readFileSync(output, "utf8"));
    assert.equal(aggregate.numTotalTestSuites, 2);
    assert.equal(aggregate.numTotalTests, 2);
    assert.equal(fs.readFileSync(victim, "utf8"), "SAFE");
    assert.equal(fs.lstatSync(predictableOldTemp).isSymbolicLink(), true);

    fs.writeFileSync(output, "stale-again");
    await assert.rejects(
      () =>
        runner.run({
          args: ["--json", `--outputFile=${output}`],
          admin,
          nonce: "output_failure",
          discover: () => ["/failed.integration-spec.ts"],
          flush: async () => {},
          runSuite: async () => {
            throw new Error("intentional suite failure");
          },
        }),
      /1 integration suite/,
    );
    assert.equal(fs.existsSync(output), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
