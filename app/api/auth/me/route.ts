import { NextResponse } from "next/server";
import { getSessionUser } from "../../../lib/auth";

export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ user: null });
  return NextResponse.json({
    user: { nickname: user.nickname, highScore: user.highScore, maxLevel: user.maxLevel },
  });
}
