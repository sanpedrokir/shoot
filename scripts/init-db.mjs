import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL);

await sql`
  CREATE TABLE IF NOT EXISTS users (
    id uuid PRIMARY KEY,
    nickname text NOT NULL,
    password_hash text NOT NULL,
    high_score integer NOT NULL DEFAULT 0,
    max_level integer NOT NULL DEFAULT 1,
    avatar text,
    created_at timestamptz NOT NULL DEFAULT now()
  )
`;

await sql`
  ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar text
`;

await sql`
  ALTER TABLE users ADD COLUMN IF NOT EXISTS wwii_high_score integer NOT NULL DEFAULT 0
`;

await sql`
  CREATE UNIQUE INDEX IF NOT EXISTS users_nickname_lower_idx ON users (LOWER(nickname))
`;

// One row per player per UTC day; a player's daily score can only go up
// (see the ON CONFLICT clause in /api/daily-score), never down.
await sql`
  CREATE TABLE IF NOT EXISTS daily_scores (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    challenge_date date NOT NULL,
    score integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, challenge_date)
  )
`;

await sql`
  CREATE INDEX IF NOT EXISTS daily_scores_date_score_idx ON daily_scores (challenge_date, score DESC)
`;

console.log("Database initialized: users + daily_scores tables and indexes are ready.");
