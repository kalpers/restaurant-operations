import { StationQueuePage } from "@/components/kitchen/station-queue-page";

export default function BarPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <StationQueuePage stationType="BAR" title="Bar" path="/bar" searchParams={searchParams} />;
}
