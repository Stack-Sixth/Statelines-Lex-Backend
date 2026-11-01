import { createClientFromRequest } from "npm:@base44/sdk@0.8.52";
export default async function (req: Request): Promise<Response> {
  const b = createClientFromRequest(req),
    user = await b.auth.me().catch(() => null);
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== "admin")
    return Response.json({ error: "Admin only" }, { status: 403 });
  return Response.json(
    {
      code: "harness_disabled",
      error:
        "Legacy platform-client harness is disabled; it cannot mutate merchant claims.",
    },
    { status: 403 },
  );
}
