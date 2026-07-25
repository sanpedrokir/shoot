export const metadata = {
  title: "Privacy Policy — Sky Raider",
};

export default function PrivacyPage() {
  return (
    <main className="fixed inset-0 overflow-y-auto bg-slate-900 text-white/90 font-sans leading-relaxed">
      <div className="mx-auto max-w-2xl px-6 py-12">
      <h1 className="text-2xl font-bold text-white">Privacy Policy</h1>
      <p className="mt-2 text-sm text-white/60">Last updated: July 2026</p>

      <p className="mt-6">
        Sky Raider (&quot;the app&quot;) is a browser-based air-combat game. This page explains what
        information the app collects and how it&apos;s used.
      </p>

      <h2 className="mt-8 text-lg font-semibold text-white">Information we collect</h2>
      <ul className="mt-3 list-disc space-y-2 pl-5">
        <li>
          <strong>Account nickname and password</strong>, if you create an account to appear on the
          leaderboard. Passwords are salted and hashed before storage — we never store or can see your
          plain-text password.
        </li>
        <li>
          <strong>Game data</strong>{" "}such as your high score and level progress, tied to your account
          if you&apos;re logged in.
        </li>
        <li>
          <strong>A randomly generated device ID</strong>, used only to coordinate a co-op session
          between you and an ally while playing together. It is not linked to your identity and is not
          stored after your session ends.
        </li>
        <li>
          <strong>Standard technical data</strong>{" "}(such as IP address) that our hosting provider
          processes automatically for any web request, used only for security and abuse prevention.
        </li>
      </ul>

      <h2 className="mt-8 text-lg font-semibold text-white">What we don&apos;t collect</h2>
      <p className="mt-3">
        We don&apos;t collect your real name, email address, location, contacts, camera, or microphone
        data, and the app has no advertising or third-party analytics trackers.
      </p>

      <h2 className="mt-8 text-lg font-semibold text-white">Third-party services</h2>
      <p className="mt-3">The app relies on a small number of infrastructure providers to run:</p>
      <ul className="mt-3 list-disc space-y-2 pl-5">
        <li>Vercel — hosting and delivering the app.</li>
        <li>Neon (PostgreSQL) — storing account and score data.</li>
        <li>Pusher — real-time messaging that powers co-op multiplayer.</li>
      </ul>
      <p className="mt-3">
        Each provider processes only the data described above, solely to make the app function.
      </p>

      <h2 className="mt-8 text-lg font-semibold text-white">Your choices</h2>
      <p className="mt-3">
        You can play without creating an account — an account is only needed to appear on the
        leaderboard. To request deletion of your account and associated data, contact us using the
        details below.
      </p>

      <h2 className="mt-8 text-lg font-semibold text-white">Contact</h2>
      <p className="mt-3">
        Questions about this policy or your data can be sent to{" "}
        <a className="underline" href="mailto:sanpedrobeach9@gmail.com">
          sanpedrobeach9@gmail.com
        </a>
        .
      </p>
      </div>
    </main>
  );
}
