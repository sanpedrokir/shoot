import { NextResponse } from "next/server";
import { sql } from "../../lib/db";

export async function GET() {
  const rows = await sql`
    SELECT u.nickname, d.score
    FROM daily_scores d
    JOIN users u ON u.id = d.user_id
    WHERE d.challenge_date = CURRENT_DATE
    ORDER BY d.score DESC
    LIMIT 10
  `;
  const top = rows as { nickname: string; score: number }[];
  return NextResponse.json({ top });
}
