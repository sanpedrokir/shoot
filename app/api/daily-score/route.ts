import { NextRequest, NextResponse } from "next/server";
import { sql } from "../../lib/db";
import { getSessionUser } from "../../lib/auth";

export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Not logged in." }, { status: 401 });

  const body = await request.json().catch(() => null);
  const score = body?.score;
  if (typeof score !== "number" || !Number.isFinite(score) || score < 0) {
    return NextResponse.json({ error: "Invalid score." }, { status: 400 });
  }

  const id = crypto.randomUUID();
  const updated = await sql`
    INSERT INTO daily_scores (id, user_id, challenge_date, score)
    VALUES (${id}, ${user.id}, CURRENT_DATE, ${Math.floor(score)})
    ON CONFLICT (user_id, challenge_date)
    DO UPDATE SET score = GREATEST(daily_scores.score, EXCLUDED.score)
    RETURNING score
  `;
  const row = updated[0] as { score: number };
  return NextResponse.json({ score: row.score });
}
