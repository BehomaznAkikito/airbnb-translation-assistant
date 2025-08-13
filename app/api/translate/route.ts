// /app/api/translate/route.ts
export const runtime = "edge";

export async function GET() {
  return Response.json({ ok: true, endpoint: "/api/translate" });
}

export async function POST(req: Request) {
  try {
    const bodyText = await req.text();
    return Response.json({ ok: true, received: bodyText || null });
  } catch (e: unknown) {
    const message =
      e instanceof Error ? e.message : typeof e === "string" ? e : "unknown";
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
