import { NextResponse } from "next/server";
import { sql } from "../../lib/db";

export async function GET() {
  const rows = await sql`
    SELECT nickname, high_score, avatar FROM users
    WHERE high_score > 0
    ORDER BY high_score DESC
    LIMIT 1
  `;
  const row = rows[0] as { nickname: string; high_score: number; avatar: string | null } | undefined;
  return NextResponse.json({
    top: row ? { nickname: row.nickname, highScore: row.high_score, avatar: row.avatar } : null,
  });
}
