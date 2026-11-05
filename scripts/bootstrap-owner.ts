import { createInterface } from "node:readline/promises";

import { loadLocalEnv } from "../src/config/tooling-env";
import { closeDatabase, getDatabase } from "../src/db";
import { bootstrapOwner } from "../src/modules/auth/services/owner-bootstrap";

const CTRL_C = "\u0003";
const BACKSPACE = ["\u0008", "\u007f"];

/** Reads a line with raw terminal input, so typed characters are never displayed. */
function promptHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    let value = "";

    const finish = (settle: () => void) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
      settle();
    };

    const onData = (chunk: Buffer) => {
      for (const character of chunk.toString("utf8")) {
        if (character === CTRL_C) {
          finish(() => reject(new Error("Cancelled.")));
          return;
        }

        if (character === "\r" || character === "\n") {
          finish(() => resolve(value));
          return;
        }

        if (BACKSPACE.includes(character)) {
          value = value.slice(0, -1);
        } else {
          value += character;
        }
      }
    };

    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

async function readFromTerminal() {
  const lines = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const email = await lines.question("Owner email: ");
  lines.close();

  const password = await promptHidden("Password (14 or more characters): ");
  const confirmation = await promptHidden("Confirm password: ");

  if (password !== confirmation) {
    throw new Error("The passwords do not match.");
  }

  return { email, password };
}

/** For provisioning: the first line is the email and the second is the password. */
async function readFromPipe() {
  let input = "";

  for await (const chunk of process.stdin) {
    input += String(chunk);
  }

  const [email = "", password = ""] = input.split(/\r?\n/);

  return { email, password };
}

async function main(): Promise<void> {
  loadLocalEnv();

  const input = process.stdin.isTTY
    ? await readFromTerminal()
    : await readFromPipe();

  try {
    const result = await bootstrapOwner(getDatabase(), input);

    console.log(
      result.userCreated
        ? "Owner account created."
        : "Account already exists; its password was not changed.",
    );
    console.log(
      result.roleAssigned
        ? "Owner role assigned at the main location."
        : "Owner role was already assigned.",
    );
  } finally {
    await closeDatabase();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Bootstrap failed.");
  process.exitCode = 1;
});
