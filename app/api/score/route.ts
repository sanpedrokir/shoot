import { NextRequest, NextResponse } from "next/server";
import { sql } from "../../lib/db";
import { getSessionUser } from "../../lib/auth";

export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Not logged in." }, { status: 401 });

  const body = await request.json().catch(() => null);
  const score = body?.score;
  const level = body?.level;
  if (typeof score !== "number" || !Number.isFinite(score) || score < 0) {
    return NextResponse.json({ error: "Invalid score." }, { status: 400 });
  }
  if (typeof level !== "number" || !Number.isFinite(level) || level < 1) {
    return NextResponse.json({ error: "Invalid level." }, { status: 400 });
  }

  const updated = await sql`
    UPDATE users
    SET high_score = GREATEST(high_score, ${Math.floor(score)}),
        max_level = GREATEST(max_level, ${Math.floor(level)})
    WHERE id = ${user.id}
    RETURNING high_score, max_level
  `;
  const row = updated[0] as { high_score: number; max_level: number };
  return NextResponse.json({ highScore: row.high_score, maxLevel: row.max_level });
}
