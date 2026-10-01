import { beforeEach,describe,expect,it,vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SwaypCreateGuideInput } from "@/lib/swayp";
const create=vi.hoisted(()=>vi.fn());
vi.mock("@/lib/swayp",()=>({createGuide:create,swaypOptsFromEnv:()=>({})}));
import { emitSwaypOnce } from "@/lib/swayp-emission";
function setup(claim:unknown={id:"claim"},saveError:null|{message:string}=null) {
  const updates:unknown[]=[];
  const rpc=vi.fn(async()=>({data:claim,error:null}));
  const admin={rpc,from:()=>({update:(row:unknown)=>{updates.push(row);return {eq:async()=>({error:saveError})};}})} as unknown as SupabaseClient;
  const args={admin,storeId:"s",orderId:"o",sourceKey:"g",city:"arequipa",input:{productos:[]} as unknown as SwaypCreateGuideInput};
  return {args,updates,rpc};
}
beforeEach(()=>vi.clearAllMocks());
describe("POST de guía como máximo una vez",()=>{
  it("no llama a Swayp sin obtener la reserva persistente",async()=>{
    const x=setup({error:"Emisión previa"});expect((await emitSwaypOnce(x.args)).ok).toBe(false);expect(create).not.toHaveBeenCalled();
  });
  it("guarda el número emitido antes de crear la salida local",async()=>{
    const x=setup();create.mockResolvedValue({guia:50001,idEstado:1});
    expect(await emitSwaypOnce(x.args)).toEqual({ok:true,guia:"50001",idEstado:1});
    expect(x.updates).toEqual([{state:"created",guide_code:"50001",swayp_state:1}]);
  });
  it("un timeout queda en revisión y nunca se reintenta dentro de la llamada",async()=>{
    const x=setup();create.mockRejectedValue(new Error("timeout"));
    expect(await emitSwaypOnce(x.args)).toMatchObject({ok:false});expect(create).toHaveBeenCalledTimes(1);
    expect(x.updates).toEqual([{state:"review",error:"timeout"}]);
  });
  it("si falla persistir una guía emitida, devuelve su número y detiene el alta local",async()=>{
    const x=setup({id:"claim"},{message:"database offline"});create.mockResolvedValue({guia:50002,idEstado:1});
    expect(await emitSwaypOnce(x.args)).toMatchObject({ok:false,reason:expect.stringContaining("50002")});expect(create).toHaveBeenCalledTimes(1);
  });
});
