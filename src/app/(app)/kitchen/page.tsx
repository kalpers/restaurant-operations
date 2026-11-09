import { StationQueuePage } from "@/components/kitchen/station-queue-page";

export default function KitchenPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <StationQueuePage stationType="KITCHEN" title="Kitchen" path="/kitchen" searchParams={searchParams} />;
}
