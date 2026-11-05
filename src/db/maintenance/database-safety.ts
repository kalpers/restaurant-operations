/**
 * Guards for destructive database operations. They are pure and run before any
 * connection opens. Messages never include URLs, which can contain credentials.
 */

const RESET_DATABASE_NAME = "restaurant_ops";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const DEFAULT_POSTGRES_PORT = "5432";

export class UnsafeDatabaseOperationError extends Error {
  constructor(operation: string, reasons: readonly string[]) {
    super(`Refusing to ${operation}:\n- ${reasons.join("\n- ")}`);
    this.name = "UnsafeDatabaseOperationError";
  }
}

type ParsedDatabaseUrl = {
  host: string;
  port: string;
  databaseName: string;
};

/**
 * Returns undefined for anything that can't be judged safely. The driver also reads
 * connection options from the query string and accepts multiple hosts, so a URL with
 * either could look local while connecting somewhere else.
 */
function parseDatabaseUrl(url: string): ParsedDatabaseUrl | undefined {
  try {
    const parsed = new URL(url);

    if (parsed.search || parsed.hash) {
      return undefined;
    }

    return {
      host: parsed.hostname.toLowerCase(),
      port: parsed.port || DEFAULT_POSTGRES_PORT,
      databaseName: parsed.pathname.slice(1),
    };
  } catch {
    return undefined;
  }
}

/** Allows `db:reset` only for the local development database. */
export function assertResetAllowed(input: {
  nodeEnv: string | undefined;
  databaseUrl: string;
}): void {
  const reasons: string[] = [];
  const parsed = parseDatabaseUrl(input.databaseUrl);

  if (input.nodeEnv !== "development") {
    reasons.push("NODE_ENV must be explicitly set to development");
  }

  if (!parsed) {
    reasons.push(
      "DATABASE_URL must be a single-host URL with no query parameters",
    );
  } else {
    if (!LOOPBACK_HOSTS.has(parsed.host)) {
      reasons.push("DATABASE_URL must use a loopback host");
    }
    if (parsed.databaseName !== RESET_DATABASE_NAME) {
      reasons.push(`the database must be named ${RESET_DATABASE_NAME}`);
    }
  }

  if (reasons.length > 0) {
    throw new UnsafeDatabaseOperationError("reset the database", reasons);
  }
}

/**
 * Allows recreating the test database only when it is `<dev database>_test` on the
 * same local server as the development database. Returns its validated name.
 */
export function assertTestDatabaseAllowed(input: {
  nodeEnv: string | undefined;
  databaseUrl: string;
  testDatabaseUrl: string;
}): string {
  const reasons: string[] = [];
  const development = parseDatabaseUrl(input.databaseUrl);
  const test = parseDatabaseUrl(input.testDatabaseUrl);

  if (input.nodeEnv === "production") {
    reasons.push("NODE_ENV must not be production");
  }

  if (!development || !test) {
    reasons.push(
      "DATABASE_URL and TEST_DATABASE_URL must be single-host URLs with no query parameters",
    );
  } else {
    if (!LOOPBACK_HOSTS.has(test.host)) {
      reasons.push("TEST_DATABASE_URL must use a loopback host");
    }
    if (test.host !== development.host || test.port !== development.port) {
      reasons.push("TEST_DATABASE_URL must be on the same server as DATABASE_URL");
    }
    if (test.databaseName !== `${development.databaseName}_test`) {
      reasons.push("the test database must be named <development database>_test");
    }
    if (!/^[a-z0-9_]+$/.test(test.databaseName)) {
      reasons.push(
        "the test database name may only use lowercase letters, digits and underscores",
      );
    }
  }

  if (reasons.length > 0 || !test) {
    throw new UnsafeDatabaseOperationError(
      "recreate the test database",
      reasons,
    );
  }

  return test.databaseName;
}
