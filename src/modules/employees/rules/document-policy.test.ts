import { describe, expect, it } from "vitest";

import { ValidationError } from "@/shared/errors/app-error";

import {
  assertDocumentAcceptable,
  attachmentDisposition,
  normalizeMimeType,
} from "./document-policy";

const maxBytes = 1024;
const PDF = Buffer.from("%PDF-1.7\n");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

describe("assertDocumentAcceptable", () => {
  it.each([
    ["application/pdf", PDF],
    ["image/png", PNG],
    ["image/jpeg", JPEG],
    ["text/plain", Buffer.from("Plain text with é and ✓\n")],
  ])("accepts real %s content", (mimeType, bytes) => {
    expect(() =>
      assertDocumentAcceptable({ bytes, mimeType, maxBytes }),
    ).not.toThrow();
  });

  it.each([
    ["application/pdf", PNG],
    ["image/png", PDF],
    ["image/jpeg", PDF],
    ["text/plain", Buffer.from([0xff, 0xfe, 0x41])],
    ["text/plain", Buffer.from([0x41, 0x00, 0x42])],
  ])("rejects %s when the bytes don't match", (mimeType, bytes) => {
    expect(() => assertDocumentAcceptable({ bytes, mimeType, maxBytes })).toThrow(
      "contents don't match",
    );
  });

  it.each(["text/html", "image/svg+xml", "application/x-msdownload", "", "constructor"])(
    "rejects the type %j",
    (mimeType) => {
      expect(() =>
        assertDocumentAcceptable({ bytes: PDF, mimeType, maxBytes }),
      ).toThrow(ValidationError);
    },
  );

  it("rejects an empty file and one over the limit, and accepts the limit", () => {
    expect(() =>
      assertDocumentAcceptable({
        bytes: Buffer.alloc(0),
        mimeType: "text/plain",
        maxBytes,
      }),
    ).toThrow("empty");
    expect(() =>
      assertDocumentAcceptable({
        bytes: Buffer.alloc(maxBytes + 1, 0x41),
        mimeType: "text/plain",
        maxBytes,
      }),
    ).toThrow("too large");
    expect(() =>
      assertDocumentAcceptable({
        bytes: Buffer.alloc(maxBytes, 0x41),
        mimeType: "text/plain",
        maxBytes,
      }),
    ).not.toThrow();
  });
});

describe("normalizeMimeType", () => {
  it("drops parameters and casing", () => {
    expect(normalizeMimeType("Text/Plain; charset=UTF-8")).toBe("text/plain");
  });
});

describe("attachmentDisposition", () => {
  it("always downloads, and keeps an ordinary name", () => {
    expect(attachmentDisposition("contract.pdf")).toBe(
      "attachment; filename=\"contract.pdf\"; filename*=UTF-8''contract.pdf",
    );
  });

  it("can't be broken by quotes, separators or line breaks", () => {
    const header = attachmentDisposition('a"; x=y\r\nSet-Cookie: b/../c.pdf');
    const plainName = /filename="([^"]*)"/.exec(header)?.[1];

    expect(header).not.toMatch(/[\r\n]/);
    expect(plainName).not.toMatch(/[";/\\]/);
  });

  it("falls back when nothing printable remains", () => {
    expect(attachmentDisposition(" ")).toContain('filename="document"');
  });
});
