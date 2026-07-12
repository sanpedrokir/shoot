import { NextRequest, NextResponse } from "next/server";
import { sql } from "../../../lib/db";
import { verifyPassword, sanitizeProgress, setSessionCookie } from "../../../lib/auth";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const nickname = typeof body?.nickname === "string" ? body.nickname.trim() : "";
  const password = body?.password;

  if (!nickname || typeof password !== "string") {
    return NextResponse.json({ error: "Enter your nickname and password." }, { status: 400 });
  }

  const rows = await sql`
    SELECT id, nickname, password_hash, high_score, max_level FROM users
    WHERE LOWER(nickname) = LOWER(${nickname})
  `;
  const row = rows[0] as
    | { id: string; nickname: string; password_hash: string; high_score: number; max_level: number }
    | undefined;

  if (!row || !verifyPassword(password, row.password_hash)) {
    return NextResponse.json({ error: "Incorrect nickname or password." }, { status: 401 });
  }

  let highScore = row.high_score;
  let maxLevel = row.max_level;
  const { localHighScore, localMaxLevel } = body;

  if (typeof localHighScore === "number" || typeof localMaxLevel === "number") {
    const candidateHighScore = sanitizeProgress(localHighScore, row.high_score);
    const candidateMaxLevel = sanitizeProgress(localMaxLevel, row.max_level);
    const updated = await sql`
      UPDATE users
      SET high_score = GREATEST(high_score, ${candidateHighScore}),
          max_level = GREATEST(max_level, ${candidateMaxLevel})
      WHERE id = ${row.id}
      RETURNING high_score, max_level
    `;
    highScore = updated[0].high_score;
    maxLevel = updated[0].max_level;
  }

  await setSessionCookie(row.id);
  return NextResponse.json({ nickname: row.nickname, highScore, maxLevel });
}
