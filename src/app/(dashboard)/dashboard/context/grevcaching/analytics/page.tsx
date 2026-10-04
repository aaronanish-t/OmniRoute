import Link from "next/link";
import { GrevCachingAnalytics } from "@/shared/components/compression/GrevCachingAnalytics";

export default function GrevCachingAnalyticsPage() {
  return (
    <main className="mx-auto max-w-7xl p-6">
      <h1 className="text-2xl font-semibold text-text">GrevCaching analytics</h1>
      <GrevCachingAnalytics />
      <Link className="mt-4 inline-block text-sm text-primary hover:underline" href="/dashboard/context/grevcaching">
        Back to GrevCaching settings
      </Link>
    </main>
  );
}
