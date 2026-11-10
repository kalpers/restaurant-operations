"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { barPlacement, formatDuration } from "@/modules/scheduling/rules/timeline-layout";
import type {
  DayTimeline,
  TimelineBar,
  TimelinePosition,
  TimelineTimeOff,
} from "@/modules/scheduling/services/timeline-service";
import { addDays } from "@/shared/time/zoned-time";

import { TimelineDetailsPanel } from "./timeline-details-panel";
import {
  clockTime,
  HATCHED_STYLE,
  POSITION_PALETTE,
  SWATCH_PALETTE,
} from "./timeline-format";

export type TimelineView = "employee" | "position";

type TimelineState = {
  date: string;
  view: TimelineView;
  includeDrafts: boolean;
  selected: string | null;
};

const LANE_HEIGHT = 40;

/** Hydration is the only change `useSyncExternalStore` needs to see here. */
const noSubscription = () => () => {};
const HOUR_WIDTH = 56;
const NAME_WIDTH = 168;

const BUTTON_CLASS =
  "inline-flex min-h-11 items-center rounded border border-neutral-400 px-3 text-sm font-medium hover:bg-neutral-100";

/** The URL for a state, leaving defaults out so links stay short. */
function timelineHref(state: TimelineState): string {
  const params = new URLSearchParams({ date: state.date });

  if (state.view !== "employee") {
    params.set("view", state.view);
  }

  if (!state.includeDrafts) {
    params.set("includeDrafts", "false");
  }

  if (state.selected) {
    params.set("selected", state.selected);
  }

  return `/scheduling/timeline?${params.toString()}`;
}

type Row = {
  key: string;
  label: string;
  detail?: string;
  bars: TimelineBar[];
  timeOff: TimelineTimeOff[];
  laneOf: (bar: TimelineBar) => number;
};

type Section = { key: string; heading: string | null; rows: Row[] };

function buildSections(data: DayTimeline, view: TimelineView): Section[] {
  const names = new Map(data.employees.map((row) => [row.id, row]));
  const positions = new Map(data.positions.map((row) => [row.id, row]));
  const timeOffFor = (employeeId: string) =>
    (data.timeOff ?? []).filter((span) => span.employeeId === employeeId);
  const openRows: Row[] = data.positions.flatMap((position) => {
    const bars = data.bars.filter(
      (bar) => bar.kind === "OPEN" && bar.positionId === position.id,
    );

    return bars.length === 0
      ? []
      : [
          {
            key: `open:${position.id}`,
            label: view === "employee" ? position.name : "Open",
            bars,
            timeOff: [],
            laneOf: (bar: TimelineBar) =>
              view === "employee" ? bar.lanes.employee : bar.lanes.position,
          },
        ];
  });

  if (view === "employee") {
    const sections: Section[] = [
      {
        key: "employees",
        heading: null,
        rows: data.employees.map((employee) => ({
          key: employee.id,
          label: employee.displayName,
          detail: formatDuration(employee.scheduledMinutes),
          bars: data.bars.filter((bar) => bar.employeeId === employee.id),
          timeOff: timeOffFor(employee.id),
          laneOf: (bar) => bar.lanes.employee,
        })),
      },
    ];

    if (openRows.length > 0) {
      sections.push({ key: "open", heading: "Open shifts", rows: openRows });
    }

    return sections;
  }

  return data.positions.map((position) => {
    const assigned = data.bars.filter(
      (bar) => bar.kind === "ASSIGNMENT" && bar.positionId === position.id,
    );
    const employeeIds = data.employees
      .map((employee) => employee.id)
      .filter((id) => assigned.some((bar) => bar.employeeId === id));
    const rows: Row[] = employeeIds.map((employeeId) => {
      const bars = assigned.filter((bar) => bar.employeeId === employeeId);

      return {
        key: `${position.id}:${employeeId}`,
        label: names.get(employeeId)?.displayName ?? "Unknown",
        detail: formatDuration(bars.reduce((total, bar) => total + bar.durationMinutes, 0)),
        bars,
        timeOff: timeOffFor(employeeId),
        laneOf: (bar) => bar.lanes.position,
      };
    });

    rows.push(...openRows.filter((row) => row.key === `open:${position.id}`));

    return {
      key: position.id,
      heading: positions.get(position.id)?.name ?? "Position",
      rows,
    };
  });
}

function barLabel(
  bar: TimelineBar,
  data: DayTimeline,
  position: TimelinePosition | undefined,
): string {
  const who =
    bar.kind === "OPEN"
      ? "Open slot"
      : (data.employees.find((row) => row.id === bar.employeeId)?.displayName ?? "Unknown");
  const draft = bar.periodStatus === "DRAFT" ? ", draft" : "";
  const nextDay = bar.endsNextDay ? " next day" : "";

  return `${who}, ${position?.name ?? "Position"}, ${clockTime(bar.startAt, data.timeZone)} to ${clockTime(bar.endAt, data.timeZone)}${nextDay}${draft}`;
}

function Track({
  data,
  window,
  height,
  children,
}: {
  data: DayTimeline;
  window: { startMs: number; endMs: number };
  height: number;
  children: ReactNode;
}) {
  return (
    <div className="relative flex-1 border-l border-neutral-200" style={{ height }}>
      {data.ticks.map((tick) => (
        <div
          key={tick.startAt}
          aria-hidden="true"
          className="absolute inset-y-0 border-l border-neutral-100"
          style={{
            left: `${barPlacement(window, { startMs: Date.parse(tick.startAt), endMs: Date.parse(tick.startAt) }).leftPercent}%`,
          }}
        />
      ))}
      {children}
    </div>
  );
}

export function ScheduleTimeline({
  data,
  view,
  selected,
}: {
  data: DayTimeline;
  view: TimelineView;
  selected: string | null;
}) {
  const router = useRouter();
  const state: TimelineState = {
    date: data.date,
    view,
    includeDrafts: data.includeDrafts,
    selected,
  };
  const window = useMemo(
    () => ({
      startMs: Date.parse(data.window.startAt),
      endMs: Date.parse(data.window.endAt),
    }),
    [data.window.startAt, data.window.endAt],
  );
  const sections = useMemo(() => buildSections(data, view), [data, view]);
  const positions = useMemo(
    () => new Map(data.positions.map((row) => [row.id, row])),
    [data.positions],
  );
  const selectedBar = data.bars.find((bar) => bar.key === selected) ?? null;
  const barRefs = useRef(new Map<string, HTMLButtonElement>());
  const returnFocusTo = useRef<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.parse(data.generatedAt));
  // False in the server render and during hydration, true once React has hydrated, so
  // tests know the bars and keys respond.
  const ready = useSyncExternalStore(
    noSubscription,
    () => true,
    () => false,
  );

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 60_000);

    return () => clearInterval(timer);
  }, []);

  const go = useCallback(
    (changes: Partial<TimelineState>) => {
      router.push(timelineHref({ ...state, ...changes }), { scroll: false });
    },
    // `state` is rebuilt from props each render; its parts are the real dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [router, state.date, state.view, state.includeDrafts, state.selected],
  );

  const close = useCallback(() => {
    returnFocusTo.current = selected;
    go({ selected: null });
  }, [go, selected]);

  // Focus goes back to the bar that opened the panel once it's closed.
  useEffect(() => {
    if (!selected && returnFocusTo.current) {
      barRefs.current.get(returnFocusTo.current)?.focus();
      returnFocusTo.current = null;
    }
  }, [selected]);

  const trackWidth = data.ticks.length * HOUR_WIDTH;
  const showNow = nowMs >= window.startMs && nowMs < window.endMs;
  const nowLeft = barPlacement(window, { startMs: nowMs, endMs: nowMs }).leftPercent;
  const previous = addDays(data.date, -1);
  const next = addDays(data.date, 1);

  return (
    <div data-testid="schedule-timeline" data-ready={ready ? "true" : "false"}>
      <div className="mb-4 flex flex-wrap items-center gap-2" role="group" aria-label="Day">
        <Link href={timelineHref({ ...state, date: previous, selected: null })} className={BUTTON_CLASS}>
          Previous day
        </Link>
        <Link href={timelineHref({ ...state, date: data.today, selected: null })} className={BUTTON_CLASS}>
          Today
        </Link>
        <Link href={timelineHref({ ...state, date: next, selected: null })} className={BUTTON_CLASS}>
          Next day
        </Link>
        <label className="flex items-center gap-2 text-sm">
          <span>Date</span>
          <input
            type="date"
            value={data.date}
            onChange={(event) => {
              if (event.target.value) {
                go({ date: event.target.value, selected: null });
              }
            }}
            className="min-h-11 rounded border border-neutral-300 bg-white px-3 text-base"
          />
        </label>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-4">
        <div className="inline-flex rounded border border-neutral-400" role="group" aria-label="Group by">
          {(["employee", "position"] as const).map((option) => (
            <Link
              key={option}
              href={timelineHref({ ...state, view: option })}
              aria-current={view === option ? "true" : undefined}
              className={`inline-flex min-h-11 items-center px-3 text-sm font-medium ${
                view === option ? "bg-neutral-800 text-white" : "hover:bg-neutral-100"
              }`}
            >
              {option === "employee" ? "By employee" : "By position"}
            </Link>
          ))}
        </div>
        {data.isReviewer && (
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={data.includeDrafts}
              onChange={(event) => go({ includeDrafts: event.target.checked, selected: null })}
              className="h-5 w-5"
            />
            Include drafts
          </label>
        )}
      </div>

      {data.positions.length > 0 && (
        <ul className="mb-4 flex flex-wrap gap-3 text-sm" aria-label="Positions">
          {data.positions.map((position) => (
            <li key={position.id} className="flex items-center gap-1">
              <span
                aria-hidden="true"
                className={`inline-block h-3 w-3 rounded-sm ${SWATCH_PALETTE[position.colorIndex]}`}
              />
              {position.name}
            </li>
          ))}
        </ul>
      )}

      {data.bars.length === 0 ? (
        <p className="text-neutral-600" data-testid="timeline-empty">
          No shifts are scheduled on {data.date}.
        </p>
      ) : (
        <div
          className="overflow-x-auto rounded border border-neutral-200"
          data-testid="timeline-frame"
        >
          <div style={{ minWidth: NAME_WIDTH + trackWidth }} className="relative">
            <div className="flex border-b border-neutral-200 bg-neutral-50 text-xs text-neutral-700">
              <div
                className="sticky left-0 z-20 shrink-0 bg-neutral-50 px-2 py-2 font-medium"
                style={{ width: NAME_WIDTH }}
              >
                {data.date}
              </div>
              <Track data={data} window={window} height={32}>
                {data.ticks.map((tick) => (
                  <span
                    key={tick.startAt}
                    className="absolute top-2 pl-1"
                    style={{
                      left: `${barPlacement(window, { startMs: Date.parse(tick.startAt), endMs: Date.parse(tick.startAt) }).leftPercent}%`,
                    }}
                  >
                    {tick.label}
                  </span>
                ))}
              </Track>
            </div>

            <section aria-label="Scheduled headcount by hour" data-testid="timeline-headcount">
              {data.positions.map((position) => (
                <div key={position.id} className="flex border-b border-neutral-100 text-xs">
                  <div
                    className="sticky left-0 z-20 flex shrink-0 items-center gap-1 bg-white px-2"
                    style={{ width: NAME_WIDTH }}
                  >
                    <span
                      aria-hidden="true"
                      className={`inline-block h-2 w-2 rounded-sm ${SWATCH_PALETTE[position.colorIndex]}`}
                    />
                    {position.name}
                  </div>
                  <div className="flex flex-1 border-l border-neutral-200">
                    {data.headcount.map((hour, index) => {
                      const count = hour.byPosition[position.id] ?? 0;

                      return (
                        <span
                          key={hour.hourStartAt}
                          className={`flex-1 py-1 text-center ${count === 0 ? "text-neutral-400" : "font-medium"}`}
                          title={`${data.ticks[index]?.label ?? ""}: ${count} ${position.name}`}
                        >
                          {count}
                        </span>
                      );
                    })}
                  </div>
                </div>
              ))}
            </section>

            {sections.map((section) => (
              <section
                key={section.key}
                aria-label={section.heading ?? "Employees"}
                data-testid="timeline-section"
              >
                {section.heading && (
                  <h2 className="border-b border-neutral-200 bg-neutral-50 py-1 text-sm font-semibold">
                    <span className="sticky left-0 inline-block px-2">{section.heading}</span>
                  </h2>
                )}
                {section.rows.map((row) => {
                  const laneCount = Math.max(1, ...row.bars.map((bar) => row.laneOf(bar) + 1));
                  const height = laneCount * LANE_HEIGHT + 8;

                  return (
                    <div
                      key={row.key}
                      className="flex border-b border-neutral-100"
                      data-testid="timeline-row"
                    >
                      <div
                        className="sticky left-0 z-20 flex shrink-0 flex-col justify-center bg-white px-2 text-sm"
                        style={{ width: NAME_WIDTH }}
                      >
                        <span className="truncate font-medium">{row.label}</span>
                        {row.detail && (
                          <span className="text-xs text-neutral-600">{row.detail} scheduled</span>
                        )}
                      </div>
                      <Track data={data} window={window} height={height}>
                        {row.timeOff.map((span) => {
                          const place = barPlacement(window, {
                            startMs: Date.parse(span.startAt),
                            endMs: Date.parse(span.endAt),
                          });

                          return (
                            <div
                              key={`${span.startAt}-${span.status}`}
                              data-testid="timeline-time-off"
                              className={`absolute inset-y-0 z-0 flex items-end px-1 pb-0.5 text-[11px] text-neutral-700 ${
                                span.status === "APPROVED"
                                  ? "bg-neutral-200"
                                  : "border-x-2 border-dashed border-neutral-500 bg-neutral-100"
                              }`}
                              style={{ left: `${place.leftPercent}%`, width: `${place.widthPercent}%` }}
                            >
                              {span.status === "APPROVED" ? "Time off" : "Pending time off"}
                            </div>
                          );
                        })}
                        {row.bars.map((bar) => {
                          const position = positions.get(bar.positionId);
                          const place = barPlacement(window, {
                            startMs: Date.parse(bar.startAt),
                            endMs: Date.parse(bar.endAt),
                          });
                          const isDraft = bar.periodStatus === "DRAFT";
                          const isOpen = bar.kind === "OPEN";
                          const color = isOpen
                            ? "border-neutral-500 text-neutral-900"
                            : POSITION_PALETTE[position?.colorIndex ?? 0];

                          return (
                            <button
                              key={bar.key}
                              type="button"
                              ref={(element) => {
                                if (element) {
                                  barRefs.current.set(bar.key, element);
                                } else {
                                  barRefs.current.delete(bar.key);
                                }
                              }}
                              data-testid="timeline-bar"
                              data-kind={bar.kind}
                              data-status={bar.periodStatus}
                              aria-label={barLabel(bar, data, position)}
                              aria-pressed={bar.key === selected}
                              onClick={() => go({ selected: bar.key })}
                              className={`absolute z-10 flex items-center gap-1 overflow-hidden rounded border-2 px-1.5 text-left text-xs leading-tight whitespace-nowrap focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 focus-visible:ring-offset-1 ${color} ${
                                isOpen || isDraft ? "border-dashed" : ""
                              } ${bar.key === selected ? "ring-2 ring-neutral-900" : ""}`}
                              style={{
                                left: `${place.leftPercent}%`,
                                width: `max(${place.widthPercent}%, 1.5rem)`,
                                top: row.laneOf(bar) * LANE_HEIGHT + 4,
                                height: LANE_HEIGHT - 4,
                                ...(isOpen ? HATCHED_STYLE : isDraft ? { backgroundColor: "white" } : {}),
                              }}
                            >
                              <span className="font-semibold">
                                {isOpen ? "Open" : (position?.name ?? "Position")}
                              </span>
                              <span>
                                {clockTime(bar.startAt, data.timeZone)}–{clockTime(bar.endAt, data.timeZone)}
                              </span>
                              {isDraft && <span className="italic">Draft</span>}
                            </button>
                          );
                        })}
                      </Track>
                    </div>
                  );
                })}
              </section>
            ))}

            {showNow && (
              <div
                aria-hidden="true"
                data-testid="timeline-now"
                className="pointer-events-none absolute inset-y-0 z-10 border-l-2 border-red-600"
                style={{
                  left: `calc(${NAME_WIDTH}px + (100% - ${NAME_WIDTH}px) * ${nowLeft / 100})`,
                }}
              />
            )}
          </div>
        </div>
      )}

      {selectedBar && (
        <TimelineDetailsPanel
          bar={selectedBar}
          data={data}
          position={positions.get(selectedBar.positionId)}
          onClose={close}
        />
      )}
    </div>
  );
}
