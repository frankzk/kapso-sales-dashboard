// RFC 8414: los metadatos del servidor de autorización de Kapta para agentes de
// IA (MOM §42.8): dónde registrarse, autorizar y canjear el código. Con PKCE
// S256 y clientes públicos.

import { NextRequest, NextResponse } from "next/server";
import { OAUTH_HEADERS, authorizationServerMetadata } from "@/lib/agent-oauth";

export const dynamic = "force-dynamic";

export function GET(req: NextRequest) {
  return NextResponse.json(authorizationServerMetadata(req.nextUrl.origin), { headers: OAUTH_HEADERS });
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: OAUTH_HEADERS });
}
