// app/api/ping/route.ts
export const runtime = "edge";

export async function GET() {
  return Response.json({
    ok: true,
    route: "/api/ping",
    env: process.env.VERCEL_ENV ?? null,
    commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
  });
}
