import { randomBytes } from "node:crypto";

import { hash, verify, type Algorithm } from "@node-rs/argon2";

export const MINIMUM_PASSWORD_LENGTH = 14;

/** Bounds hashing work on an oversized submission. */
export const MAXIMUM_PASSWORD_LENGTH = 1024;

// The package's Algorithm is an ambient const enum, which isolatedModules can't read.
const ARGON2ID = 2 as Algorithm;

/** The parameters are embedded in the resulting hash, so they can be raised later. */
const HASH_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

export function hashPassword(password: string): Promise<string> {
  return hash(password, HASH_OPTIONS);
}

export function verifyPassword(
  passwordHash: string,
  password: string,
): Promise<boolean> {
  return verify(passwordHash, password);
}

let dummyHash: Promise<string> | undefined;

/**
 * Does the work of a real verification when no account can sign in, so response time
 * doesn't reveal whether an account exists.
 */
export async function verifyAgainstDummyHash(password: string): Promise<void> {
  dummyHash ??= hashPassword(crypto.randomUUID());
  await verifyPassword(await dummyHash, password);
}

/** URL-safe: 64 characters, so `byte & 63` picks one without modulo bias. */
export const TEMPORARY_PASSWORD_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
export const TEMPORARY_PASSWORD_LENGTH = 16;

/**
 * A random temporary password for an administrator's reset (Phase 16). It is shown once to
 * the administrator and stored only as a hash: never logged, audited or kept.
 */
export function generateTemporaryPassword(): string {
  const bytes = randomBytes(TEMPORARY_PASSWORD_LENGTH);
  let password = "";

  for (const byte of bytes) {
    password += TEMPORARY_PASSWORD_ALPHABET[byte & 63];
  }

  return password;
}
