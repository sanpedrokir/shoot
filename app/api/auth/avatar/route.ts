import { NextRequest, NextResponse } from "next/server";
import { sql } from "../../../lib/db";
import { getSessionUser } from "../../../lib/auth";
import { isValidAvatarId } from "../../../lib/avatars";

export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Not logged in." }, { status: 401 });

  const body = await request.json().catch(() => null);
  const avatar = body?.avatar;
  if (avatar !== null && !isValidAvatarId(avatar)) {
    return NextResponse.json({ error: "Unknown avatar." }, { status: 400 });
  }

  await sql`UPDATE users SET avatar = ${avatar} WHERE id = ${user.id}`;
  return NextResponse.json({ avatar });
}
