import { NextResponse, after } from "next/server";
import { getDeskData } from "@/lib/desk";
import { warmSeries } from "@/lib/price-series";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Stale-while-revalidate: a cached read is answered at once and, when it is older
 * than the desk's refresh interval, the refresh runs in after() so the reader never
 * waits on the chain. Only a cold instance with nothing cached reads synchronously.
 */
export async function GET() {
  try {
    const data = await getDeskData((fn) => after(fn));
    // Keep the hourly history extending past the deployed seed; cheap once today is cached.
    after(() => warmSeries());
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json({ error: String((e as Error)?.message ?? e) }, { status: 503 });
  }
}
