// Next.js doesn't like empty dirs; Auth.js v5's handler mounts on the [...nextauth]
// route above. Keep this as a stub so the folder structure is self-explanatory.
export const dynamic = "force-static";
export async function GET() {
  return new Response("Auth.js mounted at /api/auth/[...nextauth]", { status: 200 });
}
