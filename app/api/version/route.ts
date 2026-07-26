import { NextResponse } from "next/server";

// Forces this route to actually execute per-request rather than being
// statically cached at build time -- the whole point is that it reflects
// whichever build is *currently* deployed, not whichever build first
// rendered this route.
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ buildId: process.env.NEXT_PUBLIC_BUILD_ID ?? "dev" });
}
