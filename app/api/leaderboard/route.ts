import { NextResponse } from "next/server";
import { sql } from "../../lib/db";
import { getSessionUser } from "../../lib/auth";

export async function GET() {
  const rows = await sql`
    SELECT nickname, high_score, avatar FROM users
    WHERE high_score > 0
    ORDER BY high_score DESC
    LIMIT 1
  `;
  const row = rows[0] as { nickname: string; high_score: number; avatar: string | null } | undefined;

  // Rank is 1-indexed count of strictly-higher scores, only meaningful once
  // the player actually has a score on the board -- a fresh account with 0
  // would otherwise show a meaningless "rank" tied with every other unranked
  // account.
  let myRank: number | null = null;
  const user = await getSessionUser();
  if (user && user.highScore > 0) {
    const rankRows = await sql`
      SELECT COUNT(*) + 1 AS rank FROM users WHERE high_score > ${user.highScore}
    `;
    myRank = Number((rankRows[0] as { rank: number | string }).rank);
  }

  return NextResponse.json({
    top: row ? { nickname: row.nickname, highScore: row.high_score, avatar: row.avatar } : null,
    myRank,
  });
}
