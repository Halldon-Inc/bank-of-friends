import { NextResponse } from "next/server";
import { getDeskData } from "@/lib/desk";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET() {
  try {
    return NextResponse.json(await getDeskData());
  } catch (e) {
    return NextResponse.json({ error: String((e as Error)?.message ?? e) }, { status: 503 });
  }
}
