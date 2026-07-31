"use client";

import { forwardRef, useEffect, useImperativeHandle, useState, type Ref } from "react";
import { AVATAR_OPTIONS, avatarSrcFor } from "../lib/avatars";
import type { GameTheme } from "../lib/coop";

export interface AuthPanelHandle {
  logout: () => void;
}

export interface AuthUser {
  nickname: string;
  highScore: number;
  wwiiHighScore: number;
  maxLevel: number;
  avatar: string | null;
}

export interface LeaderboardTop {
  nickname: string;
  highScore: number;
  avatar: string | null;
}

interface AuthPanelProps {
  onUserChange: (user: AuthUser | null) => void;
  refreshLeaderboardKey: number;
  // Which leaderboard/local-progress column this panel currently reflects --
  // switching it re-fetches the top/rank for that mode (see the leaderboard
  // effect below). Named gameTheme, not mode, to avoid colliding with this
  // component's own login/register `mode` state.
  gameTheme: GameTheme;
  onTopChange?: (top: LeaderboardTop | null) => void;
  // Fires whenever there's nickname/password text sitting unsubmitted (and
  // the player isn't logged in) — the parent uses this to hold off on
  // Start, so typing into the sign-up form and tapping Start doesn't
  // silently discard it and launch a guest game instead. Clearing the
  // fields (going back to "just play as guest") releases the hold.
  onPendingAuthChange?: (pending: boolean) => void;
}

// Must match FighterGame.tsx's own "skyfighter-best"/UNLOCKED_LEVEL_KEY
// exactly -- these used to be two separate, never-synced keys (this file
// had its own "skyfighter-max-level" that actual gameplay never wrote to),
// which is how a brand-new account could end up "starting" at whatever
// level a previous account on the same device had reached: registering
// read this stale, always-1 key instead of the real local progress.
function readLocalProgress(): { highScore: number; wwiiHighScore: number; maxLevel: number } {
  if (typeof window === "undefined") return { highScore: 0, wwiiHighScore: 0, maxLevel: 1 };
  try {
    const highScore = parseInt(window.localStorage.getItem("skyfighter-best") ?? "0", 10) || 0;
    const wwiiHighScore = parseInt(window.localStorage.getItem("skyfighter-wwii-best") ?? "0", 10) || 0;
    const maxLevel = parseInt(window.localStorage.getItem("skyfighter-unlocked-level") ?? "1", 10) || 1;
    return { highScore, wwiiHighScore, maxLevel };
  } catch {
    return { highScore: 0, wwiiHighScore: 0, maxLevel: 1 };
  }
}

function storeLocalProgress(highScore: number, wwiiHighScore: number, maxLevel: number) {
  try {
    window.localStorage.setItem("skyfighter-best", String(highScore));
    window.localStorage.setItem("skyfighter-wwii-best", String(wwiiHighScore));
    window.localStorage.setItem("skyfighter-unlocked-level", String(maxLevel));
  } catch {
    // ignore
  }
}

type Mode = "login" | "register";

function AuthPanel(
  { onUserChange, refreshLeaderboardKey, gameTheme, onTopChange, onPendingAuthChange }: AuthPanelProps,
  ref: Ref<AuthPanelHandle>
) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [checkedSession, setCheckedSession] = useState(false);
  const [mode, setMode] = useState<Mode>("login");
  const [nickname, setNickname] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [top, setTop] = useState<LeaderboardTop | null>(null);
  const [myRank, setMyRank] = useState<number | null>(null);
  const [leaderboardChecked, setLeaderboardChecked] = useState(false);
  const [showAvatarPicker, setShowAvatarPicker] = useState(false);
  const [avatarSaving, setAvatarSaving] = useState(false);
  // Sign-up is a two-step flow: nickname/password, then (once those are
  // valid) an avatar pick before the account is actually created --
  // "signup" only ever applies when mode === "register".
  const [signupStep, setSignupStep] = useState<"form" | "avatar">("form");

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
    fetch(`/api/leaderboard?mode=${gameTheme}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((data: { top: LeaderboardTop | null; myRank: number | null }) => {
        setTop(data.top);
        setMyRank(data.myRank);
        onTopChange?.(data.top);
      })
      .catch(() => {})
      .finally(() => setLeaderboardChecked(true));
    // onTopChange is a fresh closure each render; only re-fetch when the
    // parent explicitly bumps refreshLeaderboardKey or switches mode.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshLeaderboardKey, gameTheme]);

  useEffect(() => {
    onPendingAuthChange?.(!user && (nickname.trim().length > 0 || password.length > 0));
    // onPendingAuthChange is a fresh closure each render; only re-evaluate
    // when the actual pending state (user/nickname/password) changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, nickname, password]);

  // avatarId is only ever passed from the sign-up avatar step below; login
  // never sets one here (an existing account keeps whatever it already has).
  const submit = async (avatarId?: string) => {
    setError("");
    if (!nickname.trim() || !password) {
      setError("Enter a nickname and password.");
      setSignupStep("form");
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
          localWwiiHighScore: local.wwiiHighScore,
          localMaxLevel: local.maxLevel,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Something went wrong.");
        setSignupStep("form");
        return;
      }
      let avatar: string | null = data.avatar;
      if (avatarId) {
        // Best-effort: the account already exists at this point regardless
        // of whether this call succeeds, so a failure here just means they
        // can still pick one later via the gear icon.
        try {
          const avRes = await fetch("/api/auth/avatar", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ avatar: avatarId }),
          });
          if (avRes.ok) avatar = avatarId;
        } catch {
          // ignore
        }
      }
      const nextUser: AuthUser = {
        nickname: data.nickname,
        highScore: data.highScore,
        wwiiHighScore: data.wwiiHighScore,
        maxLevel: data.maxLevel,
        avatar,
      };
      setUser(nextUser);
      onUserChange(nextUser);
      setPassword("");
      setSignupStep("form");
      storeLocalProgress(nextUser.highScore, nextUser.wwiiHighScore, nextUser.maxLevel);
    } catch {
      setError("Network error. Try again.");
      setSignupStep("form");
    } finally {
      setSubmitting(false);
    }
  };

  // The sign-up form's own "Continue" button -- just moves to the avatar
  // step client-side, no request yet (the account isn't created until an
  // avatar is picked or skipped).
  const goToAvatarStep = () => {
    setError("");
    if (!nickname.trim() || !password) {
      setError("Enter a nickname and password.");
      return;
    }
    setSignupStep("avatar");
  };

  const clearAndPlayAsGuest = () => {
    setNickname("");
    setPassword("");
    setError("");
    setSignupStep("form");
  };

  useImperativeHandle(
    ref,
    () => ({
      logout: async () => {
        try {
          await fetch("/api/auth/logout", { method: "POST" });
        } catch {
          // ignore
        }
        setUser(null);
        onUserChange(null);
      },
    }),
    [onUserChange]
  );

  const pickAvatar = async (avatarId: string) => {
    if (!user || avatarSaving) return;
    setAvatarSaving(true);
    try {
      const res = await fetch("/api/auth/avatar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ avatar: avatarId }),
      });
      if (res.ok) {
        const nextUser = { ...user, avatar: avatarId };
        setUser(nextUser);
        onUserChange(nextUser);
        setShowAvatarPicker(false);
      }
    } catch {
      // ignore
    } finally {
      setAvatarSaving(false);
    }
  };

  const hasPendingInput = !user && (nickname.trim().length > 0 || password.length > 0);

  return (
    <div className="flex flex-col items-center gap-2 text-white">
      {leaderboardChecked && (
        <p className="flex items-center gap-1.5 rounded-full border border-yellow-400/30 bg-black/30 px-4 py-1.5 text-base font-bold text-yellow-300 shadow-[inset_0_1px_0_rgba(255,255,255,0.1),0_4px_10px_-4px_rgba(0,0,0,0.6)]">
          {top ? (
            <>
              <img
                src={avatarSrcFor(top.avatar)}
                alt=""
                className="h-5 w-5 rounded-full ring-1 ring-yellow-300/60"
              />
              🏆 {top.nickname} — {top.highScore}
            </>
          ) : (
            "🏆 No scores yet — be the first!"
          )}
        </p>
      )}

      {checkedSession && (user ? (
        <div className="flex flex-col items-center gap-1.5">
          <div className="flex items-center gap-2 text-xs text-white/70">
            <img
              src={avatarSrcFor(user.avatar)}
              alt=""
              className="h-6 w-6 rounded-full ring-1 ring-white/30"
            />
            <span className="font-semibold text-white">{user.nickname}</span>
            {myRank != null && (
              <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-bold text-white/80">
                Rank #{myRank}
              </span>
            )}
            <button
              onClick={() => setShowAvatarPicker((v) => !v)}
              aria-label="Avatar settings"
              className="rounded-full bg-white/10 px-1.5 py-1 leading-none active:scale-95 transition-transform"
            >
              ⚙️
            </button>
          </div>
          {showAvatarPicker && (
            <div className="flex max-w-72 flex-col items-center gap-1.5 rounded-xl bg-white/10 px-3 py-2.5">
              <p className="text-[10px] uppercase tracking-wide text-white/50">Choose your avatar</p>
              <div className="flex flex-wrap justify-center gap-1.5">
                {AVATAR_OPTIONS.map((opt) => (
                  <button
                    key={opt.id}
                    onClick={() => pickAvatar(opt.id)}
                    aria-label={opt.label}
                    disabled={avatarSaving}
                    className={`rounded-full transition-transform active:scale-95 disabled:opacity-50 ${
                      user.avatar === opt.id ? "ring-2 ring-blue-400" : ""
                    }`}
                  >
                    <img src={opt.src} alt={opt.label} className="h-9 w-9 rounded-full" />
                  </button>
                ))}
              </div>
            </div>
          )}
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
                  setSignupStep("form");
                }}
                className={`rounded-full px-3 py-1 font-semibold transition-colors ${
                  mode === m ? "bg-red-600" : "text-white/70"
                }`}
              >
                {m === "login" ? "Log In" : "Sign Up"}
              </button>
            ))}
          </div>

          {mode === "register" && signupStep === "avatar" ? (
            <div className="flex w-full flex-col items-center gap-2">
              <p className="text-xs font-semibold text-white/80">Pick your avatar</p>
              <div className="flex flex-wrap justify-center gap-1.5">
                {AVATAR_OPTIONS.map((opt) => (
                  <button
                    key={opt.id}
                    onClick={() => submit(opt.id)}
                    disabled={submitting}
                    aria-label={opt.label}
                    className="rounded-full transition-transform active:scale-95 disabled:opacity-50"
                  >
                    <img src={opt.src} alt={opt.label} className="h-11 w-11 rounded-full" />
                  </button>
                ))}
              </div>
              {error && <p className="text-xs text-red-200">{error}</p>}
              <div className="mt-0.5 flex gap-3 text-[11px]">
                <button onClick={() => setSignupStep("form")} className="underline underline-offset-2">
                  Back
                </button>
                <button onClick={() => submit()} disabled={submitting} className="underline underline-offset-2">
                  {submitting ? "…" : "Skip for now"}
                </button>
              </div>
            </div>
          ) : (
            <>
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
                  if (e.key !== "Enter") return;
                  if (mode === "register") goToAvatarStep();
                  else submit();
                }}
              />
              {error && <p className="text-xs text-red-200">{error}</p>}
              <button
                onClick={() => (mode === "register" ? goToAvatarStep() : submit())}
                disabled={submitting}
                className="mt-0.5 rounded-full bg-white/20 px-5 py-1.5 text-xs font-semibold disabled:opacity-50"
              >
                {submitting ? "…" : mode === "login" ? "Log In" : "Continue"}
              </button>
              {hasPendingInput && (
                <p className="text-center text-[11px] text-amber-200">
                  {mode === "login" ? "Log in" : "Create your account"} above to play under this name, or{" "}
                  <button onClick={clearAndPlayAsGuest} className="underline underline-offset-2">
                    clear to play as guest
                  </button>
                  .
                </p>
              )}
            </>
          )}
        </div>
      ))}
    </div>
  );
}

export default forwardRef(AuthPanel);
