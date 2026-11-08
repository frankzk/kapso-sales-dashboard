// RFC 9728: los metadatos del recurso protegido `/api/mcp` (MOM §42.8). El 401
// de `/api/mcp` apunta aquí; dice que quien autoriza es este mismo sitio. Se
// sirve en la raíz y con el camino del recurso (`…/oauth-protected-resource/api/mcp`),
// que es donde lo buscan los clientes MCP.

import { NextRequest, NextResponse } from "next/server";
import { OAUTH_HEADERS, protectedResourceMetadata } from "@/lib/agent-oauth";

export const dynamic = "force-dynamic";

export function GET(req: NextRequest) {
  return NextResponse.json(protectedResourceMetadata(req.nextUrl.origin), { headers: OAUTH_HEADERS });
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: OAUTH_HEADERS });
}
