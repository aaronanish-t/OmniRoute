import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getGrevCachingAnalytics } from "@/lib/db/compressionAnalytics";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  const value = new URL(request.url).searchParams.get("since") ?? "7d";
  const since = ["24h", "7d", "30d", "all"].includes(value)
    ? (value as "24h" | "7d" | "30d" | "all")
    : "7d";
  try {
    return NextResponse.json(getGrevCachingAnalytics(since));
  } catch (error) {
    console.error(
      "[/api/context/grev-caching/analytics]",
      error instanceof Error ? error.message : String(error)
    );
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
