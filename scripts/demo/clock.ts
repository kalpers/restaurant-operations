// The demo's movable clock. The history steps run real services "in the past" by moving
// `new Date()` and `Date.now()` for this script only, so business dates, effective dates,
// tenders and sessions all agree and nothing frozen is rewritten afterwards.

const RealDate = Date;
let offsetMs = 0;

/** Moves `new Date()` and `Date.now()` for this script only. Restored by `restoreClock`. */
export function installShiftedClock(): void {
  class ShiftedDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) {
        super(RealDate.now() + offsetMs);
      } else {
        super(...(args as [string | number | Date]));
      }
    }

    static now(): number {
      return RealDate.now() + offsetMs;
    }
  }

  globalThis.Date = ShiftedDate as DateConstructor;
}

export function setClock(instant: Date): void {
  offsetMs = instant.getTime() - RealDate.now();
}

export function restoreClock(): void {
  globalThis.Date = RealDate;
  offsetMs = 0;
}

/** Runs `work` with the clock at `instant`, then puts the real clock back. */
export async function atInstant<T>(instant: Date, work: () => Promise<T>): Promise<T> {
  installShiftedClock();
  setClock(instant);

  try {
    return await work();
  } finally {
    restoreClock();
  }
}
