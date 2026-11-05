import { describe, expect, it } from "vitest";

import {
  assertResetAllowed,
  assertTestDatabaseAllowed,
  UnsafeDatabaseOperationError,
} from "./database-safety";

const developmentUrl = "postgresql://user:s3cret@localhost:5432/restaurant_ops";
const testUrl = "postgresql://user:s3cret@localhost:5432/restaurant_ops_test";

describe("assertResetAllowed", () => {
  const rdsHost = "restaurant.abc123.us-east-1.rds.amazonaws.com";

  it.each([
    ["localhost", "postgresql://u:p@localhost:5432/restaurant_ops"],
    ["IPv4 loopback", "postgresql://u:p@127.0.0.1:5432/restaurant_ops"],
    ["IPv6 loopback", "postgresql://u:p@[::1]:5432/restaurant_ops"],
    ["uppercase host", "postgres://u:p@LOCALHOST/restaurant_ops"],
    ["a non-default port", "postgresql://u:p@localhost:5433/restaurant_ops"],
  ])("allows %s", (_label, databaseUrl) => {
    expect(() =>
      assertResetAllowed({ nodeEnv: "development", databaseUrl }),
    ).not.toThrow();
  });

  it.each([["production"], ["test"], ["staging"], [undefined], [""]])(
    "refuses NODE_ENV=%s",
    (nodeEnv) => {
      expect(() =>
        assertResetAllowed({ nodeEnv, databaseUrl: developmentUrl }),
      ).toThrow(/NODE_ENV/);
    },
  );

  it.each([
    ["an RDS host", `postgresql://u:p@${rdsHost}:5432/restaurant_ops`],
    ["a loopback lookalike", "postgresql://u:p@localhost.evil.test/restaurant_ops"],
    ["a loopback subdomain", "postgresql://u:p@127.0.0.1.nip.io/restaurant_ops"],
    ["credentials shaped like a host", "postgresql://localhost:5432@db.test/restaurant_ops"],
    ["all interfaces", "postgresql://u:p@0.0.0.0:5432/restaurant_ops"],
    ["a private address", "postgresql://u:p@10.0.0.5:5432/restaurant_ops"],
  ])("refuses %s", (_label, databaseUrl) => {
    expect(() =>
      assertResetAllowed({ nodeEnv: "development", databaseUrl }),
    ).toThrow(/loopback/);
  });

  it.each([
    ["another database", "postgresql://u:p@localhost/postgres"],
    ["the test database", "postgresql://u:p@localhost/restaurant_ops_test"],
    ["a similar name", "postgresql://u:p@localhost/restaurant_ops2"],
    ["a different case", "postgresql://u:p@localhost/RESTAURANT_OPS"],
    ["an encoded name", "postgresql://u:p@localhost/restaurant%5Fops"],
    ["a nested path", "postgresql://u:p@localhost/restaurant_ops/x"],
    ["no database", "postgresql://u:p@localhost"],
  ])("refuses %s", (_label, databaseUrl) => {
    expect(() =>
      assertResetAllowed({ nodeEnv: "development", databaseUrl }),
    ).toThrow(/named restaurant_ops/);
  });

  it.each([
    ["a host override", `postgresql://u:p@localhost/restaurant_ops?host=${rdsHost}`],
    ["a database override", "postgresql://u:p@localhost/restaurant_ops?db=production"],
    ["any option", "postgresql://u:p@localhost/restaurant_ops?sslmode=require"],
    ["an empty-host URL", `postgresql:///restaurant_ops?host=${rdsHost}`],
    ["a malformed URL", "not a url"],
  ])("refuses %s", (_label, databaseUrl) => {
    expect(() =>
      assertResetAllowed({ nodeEnv: "development", databaseUrl }),
    ).toThrow(/no query parameters/);
  });

  it("refuses multiple hosts", () => {
    const databaseUrl = `postgresql://u:p@localhost,${rdsHost}/restaurant_ops`;

    expect(() =>
      assertResetAllowed({ nodeEnv: "development", databaseUrl }),
    ).toThrow(UnsafeDatabaseOperationError);
  });

  it("reports every problem without revealing the URL", () => {
    const check = () =>
      assertResetAllowed({
        nodeEnv: "production",
        databaseUrl: `postgresql://admin:s3cret@${rdsHost}/app`,
      });

    expect(check).toThrow(/NODE_ENV[\s\S]*loopback[\s\S]*named restaurant_ops/);
    expect(check).not.toThrow(/s3cret|admin|amazonaws/);
  });
});

describe("assertTestDatabaseAllowed", () => {
  const allowed = {
    nodeEnv: "test",
    databaseUrl: developmentUrl,
    testDatabaseUrl: testUrl,
  };

  it("returns the validated test database name", () => {
    expect(assertTestDatabaseAllowed(allowed)).toBe("restaurant_ops_test");
  });

  it("treats a missing port as the default port", () => {
    expect(
      assertTestDatabaseAllowed({
        ...allowed,
        databaseUrl: "postgresql://u:p@localhost/restaurant_ops",
      }),
    ).toBe("restaurant_ops_test");
  });

  it("allows development mode", () => {
    expect(assertTestDatabaseAllowed({ ...allowed, nodeEnv: "development" })).toBe(
      "restaurant_ops_test",
    );
  });

  it("refuses production mode", () => {
    expect(() =>
      assertTestDatabaseAllowed({ ...allowed, nodeEnv: "production" }),
    ).toThrow(/production/);
  });

  it("refuses the development database itself", () => {
    expect(() =>
      assertTestDatabaseAllowed({ ...allowed, testDatabaseUrl: developmentUrl }),
    ).toThrow(/_test/);
  });

  it.each([
    ["a non-matching test name", "postgresql://u:p@localhost:5432/other_test"],
    ["a name without the suffix", "postgresql://u:p@localhost:5432/restaurant_ops_copy"],
  ])("refuses %s", (_label, testDatabaseUrl) => {
    expect(() =>
      assertTestDatabaseAllowed({ ...allowed, testDatabaseUrl }),
    ).toThrow(/_test/);
  });

  it("refuses another server", () => {
    expect(() =>
      assertTestDatabaseAllowed({
        ...allowed,
        testDatabaseUrl: "postgresql://u:p@localhost:5433/restaurant_ops_test",
      }),
    ).toThrow(/same server/);
  });

  it("refuses a remote server even when both URLs match", () => {
    expect(() =>
      assertTestDatabaseAllowed({
        ...allowed,
        databaseUrl: "postgresql://u:p@db.example.test/restaurant_ops",
        testDatabaseUrl: "postgresql://u:p@db.example.test/restaurant_ops_test",
      }),
    ).toThrow(/loopback/);
  });

  it("refuses query parameters on either URL", () => {
    expect(() =>
      assertTestDatabaseAllowed({
        ...allowed,
        testDatabaseUrl: `${testUrl}?host=db.example.test`,
      }),
    ).toThrow(/no query parameters/);
    expect(() =>
      assertTestDatabaseAllowed({
        ...allowed,
        databaseUrl: `${developmentUrl}?host=db.example.test`,
      }),
    ).toThrow(/no query parameters/);
  });

  it("refuses a name that is unsafe to use as an identifier", () => {
    expect(() =>
      assertTestDatabaseAllowed({
        ...allowed,
        databaseUrl: 'postgresql://u:p@localhost/Bad"Name',
        testDatabaseUrl: 'postgresql://u:p@localhost/Bad"Name_test',
      }),
    ).toThrow(/lowercase/);
  });
});
