import Pusher from "pusher";
import { NextRequest, NextResponse } from "next/server";

const pusher = new Pusher({
  appId: process.env.PUSHER_APP_ID!,
  key: process.env.PUSHER_KEY!,
  secret: process.env.PUSHER_SECRET!,
  cluster: process.env.PUSHER_CLUSTER!,
  useTLS: true,
});

const MAX_PLAYERS = 3;

export async function POST(request: NextRequest) {
  const body = await request.formData();
  const socketId = body.get("socket_id");
  const channelName = body.get("channel_name");
  const clientId = body.get("client_id");
  const displayName = body.get("display_name");

  if (typeof socketId !== "string" || typeof channelName !== "string") {
    return NextResponse.json({ error: "Missing socket_id or channel_name" }, { status: 400 });
  }
  // Only ever authorize our own co-op room channels, never an arbitrary channel.
  if (!channelName.startsWith("presence-skyfighter-room-")) {
    return NextResponse.json({ error: "Unknown channel" }, { status: 403 });
  }

  const userId = typeof clientId === "string" && clientId ? clientId : crypto.randomUUID();

  try {
    const usersRes = await pusher.get({ path: `/channels/${channelName}/users` });
    if (usersRes.status === 200) {
      const data = (await usersRes.json()) as { users?: { id: string }[] };
      const existing = data.users ?? [];
      const alreadyIn = existing.some((u) => u.id === userId);
      if (!alreadyIn && existing.length >= MAX_PLAYERS) {
        return NextResponse.json({ error: "Room is full" }, { status: 403 });
      }
    }
  } catch {
    // If the membership check itself fails, fail open rather than blocking play.
  }

  const authResponse = pusher.authorizeChannel(socketId, channelName, {
    user_id: userId,
    user_info: { name: typeof displayName === "string" && displayName ? displayName : "Pilot" },
  });

  return NextResponse.json(authResponse);
}
