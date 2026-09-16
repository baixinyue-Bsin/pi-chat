import { NextResponse } from "next/server";
import type { AppUpdateResponse } from "@/lib/api-types";

export const dynamic = "force-dynamic";

const CURRENT_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0";
export async function GET() {
  return NextResponse.json({
    currentVersion: CURRENT_VERSION,
    latestVersion: CURRENT_VERSION,
    updateAvailable: false,
    releaseUrl: "",
  } satisfies AppUpdateResponse);
}
