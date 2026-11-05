import { getDatabase } from "@/db";
import { checkDatabaseHealth } from "@/infrastructure/health/check-database-health";

export async function GET() {
  const health = await checkDatabaseHealth(getDatabase);

  return Response.json(health, { status: health.status === "ok" ? 200 : 503 });
}
