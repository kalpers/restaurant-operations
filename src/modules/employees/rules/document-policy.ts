import { ValidationError } from "@/shared/errors/app-error";

const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function isUtf8Text(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) {
    return false;
  }

  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

const CONTENT_CHECKS: Readonly<Record<string, (bytes: Uint8Array) => boolean>> = {
  "application/pdf": (bytes) => startsWith(bytes, PDF),
  "image/png": (bytes) => startsWith(bytes, PNG),
  "image/jpeg": (bytes) => startsWith(bytes, JPEG),
  "text/plain": isUtf8Text,
};

export const ALLOWED_DOCUMENT_MIME_TYPES = Object.keys(CONTENT_CHECKS);

/** Checks the size, the declared type and that the bytes really are that type. */
export function assertDocumentAcceptable(input: {
  bytes: Uint8Array;
  mimeType: string;
  maxBytes: number;
}): void {
  if (input.bytes.length === 0) {
    throw new ValidationError("The file is empty.");
  }

  if (input.bytes.length > input.maxBytes) {
    throw new ValidationError("The file is too large.");
  }

  const matchesType = Object.hasOwn(CONTENT_CHECKS, input.mimeType)
    ? CONTENT_CHECKS[input.mimeType]
    : undefined;

  if (!matchesType) {
    throw new ValidationError("Upload a PDF, PNG, JPEG or plain text file.");
  }

  if (!matchesType(input.bytes)) {
    throw new ValidationError("The file's contents don't match its type.");
  }
}

/** The file's type, normalized: "text/plain; charset=utf-8" becomes "text/plain". */
export function normalizeMimeType(mimeType: string): string {
  return (mimeType.split(";")[0] ?? "").trim().toLowerCase();
}

/** A Content-Disposition header that a stored display name can't break out of. */
export function attachmentDisposition(name: string): string {
  const ascii = name
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\/;]/g, "_")
    .trim();
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

  return `attachment; filename="${ascii || "document"}"; filename*=UTF-8''${encoded}`;
}
