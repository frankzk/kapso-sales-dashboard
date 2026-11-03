import { beforeEach,describe,expect,it,vi } from "vitest";
import { NextRequest } from "next/server";
const m=vi.hoisted(()=>({allowed:false,process:vi.fn(),admin:vi.fn()}));
vi.mock("@/lib/voice-recovery-server",()=>({internalAuthorized:()=>m.allowed}));
vi.mock("@/lib/db",()=>({createAdminSupabase:m.admin}));
vi.mock("@/lib/woo-sale-return-server",()=>({processWooSaleReturn:m.process}));
import { GET } from "@/app/api/cron/woo-sale-returns/route";
beforeEach(()=>{vi.clearAllMocks();m.allowed=false;m.process.mockResolvedValue({state:"skipped"});m.admin.mockReturnValue({admin:true});});
const request=()=>GET(new NextRequest("https://kapta.test/api/cron/woo-sale-returns"));
describe("cron de retorno y stock Woo",()=>{
  it("sin secreto interno no crea cliente de servicio ni procesa stock",async()=>{expect((await request()).status).toBe(401);expect(m.admin).not.toHaveBeenCalled();expect(m.process).not.toHaveBeenCalled();});
  it("termina al no haber expedientes listos",async()=>{m.allowed=true;expect((await request()).status).toBe(200);expect(m.process).toHaveBeenCalledTimes(1);});
  it("un fallo deja el control visible como fallido y limita el trabajo",async()=>{m.allowed=true;m.process.mockResolvedValue({state:"pending",error:"No confirmado"});expect((await request()).status).toBe(502);expect(m.process).toHaveBeenCalledTimes(2);});
});
