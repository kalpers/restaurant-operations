/** True in the Next.js Node.js server runtime (not Edge, not the browser). */
export function isNodeServerRuntime(): boolean {
  return process.env.NEXT_RUNTIME === "nodejs";
}
