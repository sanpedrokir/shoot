import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL);

await sql`
  CREATE TABLE IF NOT EXISTS users (
    id uuid PRIMARY KEY,
    nickname text NOT NULL,
    password_hash text NOT NULL,
    high_score integer NOT NULL DEFAULT 0,
    max_level integer NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT now()
  )
`;

await sql`
  CREATE UNIQUE INDEX IF NOT EXISTS users_nickname_lower_idx ON users (LOWER(nickname))
`;

console.log("Database initialized: users table + nickname index are ready.");
