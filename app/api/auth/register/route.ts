import { NextRequest, NextResponse } from "next/server";
import { sql } from "../../../lib/db";
import { hashPassword, NICKNAME_PATTERN, sanitizeProgress, setSessionCookie } from "../../../lib/auth";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const nickname = typeof body?.nickname === "string" ? body.nickname.trim() : "";
  const password = body?.password;

  if (!NICKNAME_PATTERN.test(nickname)) {
    return NextResponse.json(
      { error: "Nickname must be 3-20 characters (letters, numbers, spaces, - or _)." },
      { status: 400 }
    );
  }
  if (typeof password !== "string" || password.length < 4) {
    return NextResponse.json({ error: "Password must be at least 4 characters." }, { status: 400 });
  }

  const highScore = sanitizeProgress(body?.localHighScore, 0);
  const maxLevel = Math.max(1, sanitizeProgress(body?.localMaxLevel, 1));
  const id = crypto.randomUUID();
  const passwordHash = hashPassword(password);

  try {
    await sql`
      INSERT INTO users (id, nickname, password_hash, high_score, max_level)
      VALUES (${id}, ${nickname}, ${passwordHash}, ${highScore}, ${maxLevel})
    `;
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      return NextResponse.json({ error: "That nickname is taken." }, { status: 409 });
    }
    throw err;
  }

  await setSessionCookie(id);
  return NextResponse.json({ nickname, highScore, maxLevel });
}
