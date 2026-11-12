import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { failureCode, type MessageSender, type OutboundMessage, type SendResult } from "./message-sender";

/**
 * Development and test adapter (policy 1): writes each message as a JSON file and sends
 * nothing. A resend of the same message overwrites its file. The folder is outside `public/`.
 */
export class CaptureSender implements MessageSender {
  readonly name = "capture";

  constructor(private readonly folder: string) {}

  async send(message: OutboundMessage): Promise<SendResult> {
    const file = path.join(this.folder, `${message.channel.toLowerCase()}-${message.id}.json`);

    try {
      await mkdir(this.folder, { recursive: true, mode: 0o700 });
      await writeFile(file, JSON.stringify({ ...message, capturedAt: new Date().toISOString() }, null, 2), {
        mode: 0o600,
      });

      return { ok: true, providerMessageId: `capture-${message.id}` };
    } catch (error) {
      return {
        ok: false,
        kind: "TRANSIENT",
        code: failureCode(`capture:${(error as NodeJS.ErrnoException).code ?? "IO"}`),
      };
    }
  }
}
