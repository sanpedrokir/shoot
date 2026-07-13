"use client";

import { useEffect, useState } from "react";

export interface AuthUser {
  nickname: string;
  highScore: number;
  maxLevel: number;
}

interface LeaderboardTop {
  nickname: string;
  highScore: number;
}

interface AuthPanelProps {
  onUserChange: (user: AuthUser | null) => void;
  refreshLeaderboardKey: number;
}

function readLocalProgress(): { highScore: number; maxLevel: number } {
  if (typeof window === "undefined") return { highScore: 0, maxLevel: 1 };
  try {
    const highScore = parseInt(window.localStorage.getItem("skyfighter-best") ?? "0", 10) || 0;
    const maxLevel = parseInt(window.localStorage.getItem("skyfighter-max-level") ?? "1", 10) || 1;
    return { highScore, maxLevel };
  } catch {
    return { highScore: 0, maxLevel: 1 };
  }
}

function storeLocalProgress(highScore: number, maxLevel: number) {
  try {
    window.localStorage.setItem("skyfighter-best", String(highScore));
    window.localStorage.setItem("skyfighter-max-level", String(maxLevel));
  } catch {
    // ignore
  }
}

type Mode = "login" | "register";

export default function AuthPanel({ onUserChange, refreshLeaderboardKey }: AuthPanelProps) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [checkedSession, setCheckedSession] = useState(false);
  const [mode, setMode] = useState<Mode>("login");
  const [nickname, setNickname] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [top, setTop] = useState<LeaderboardTop | null>(null);
  const [leaderboardChecked, setLeaderboardChecked] = useState(false);

  useEffect(() => {
    fetch("/api/auth/me", { cache: "no-store" })
      .then((r) => r.json())
      .then((data: { user: AuthUser | null }) => {
        setUser(data.user);
        onUserChange(data.user);
      })
      .catch(() => {})
      .finally(() => setCheckedSession(true));
    // Runs once on mount to resolve the existing session, if any.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    fetch("/api/leaderboard", { cache: "no-store" })
      .then((r) => r.json())
      .then((data: { top: LeaderboardTop | null }) => setTop(data.top))
      .catch(() => {})
      .finally(() => setLeaderboardChecked(true));
  }, [refreshLeaderboardKey]);

  const submit = async () => {
    setError("");
    if (!nickname.trim() || !password) {
      setError("Enter a nickname and password.");
      return;
    }
    setSubmitting(true);
    const local = readLocalProgress();
    try {
      const res = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nickname: nickname.trim(),
          password,
          localHighScore: local.highScore,
          localMaxLevel: local.maxLevel,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Something went wrong.");
        return;
      }
      const nextUser: AuthUser = { nickname: data.nickname, highScore: data.highScore, maxLevel: data.maxLevel };
      setUser(nextUser);
      onUserChange(nextUser);
      setPassword("");
      storeLocalProgress(nextUser.highScore, nextUser.maxLevel);
    } catch {
      setError("Network error. Try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const logout = async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      // ignore
    }
    setUser(null);
    onUserChange(null);
  };

  return (
    <div className="flex flex-col items-center gap-2 text-white">
      {leaderboardChecked && (
        <p className="rounded-full bg-black/30 px-4 py-1.5 text-base font-bold text-yellow-300">
          {top ? (
            <>
              🏆 {top.nickname} — {top.highScore}
            </>
          ) : (
            "🏆 No scores yet — be the first!"
          )}
        </p>
      )}

      {checkedSession && (user ? (
        <div className="flex items-center gap-2 text-xs text-white/70">
          <span>
            Playing as <span className="font-semibold text-white">{user.nickname}</span>
          </span>
          <button onClick={logout} className="underline underline-offset-2">
            Logout
          </button>
        </div>
      ) : (
        <div className="flex w-64 flex-col items-center gap-1.5 rounded-xl bg-white/10 px-4 py-3">
          <div className="flex gap-2 rounded-full bg-white/10 p-1 text-xs">
            {(["login", "register"] as Mode[]).map((m) => (
              <button
                key={m}
                onClick={() => {
                  setMode(m);
                  setError("");
                }}
                className={`rounded-full px-3 py-1 font-semibold transition-colors ${
                  mode === m ? "bg-red-600" : "text-white/70"
                }`}
              >
                {m === "login" ? "Log In" : "Sign Up"}
              </button>
            ))}
          </div>
          <input
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            placeholder="Nickname"
            maxLength={20}
            className="w-full rounded-lg bg-white/90 px-3 py-1.5 text-sm text-black"
          />
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            type="password"
            placeholder="Password"
            className="w-full rounded-lg bg-white/90 px-3 py-1.5 text-sm text-black"
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
          />
          {error && <p className="text-xs text-red-200">{error}</p>}
          <button
            onClick={submit}
            disabled={submitting}
            className="mt-0.5 rounded-full bg-white/20 px-5 py-1.5 text-xs font-semibold disabled:opacity-50"
          >
            {submitting ? "…" : mode === "login" ? "Log In" : "Create Account"}
          </button>
        </div>
      ))}
    </div>
  );
}
