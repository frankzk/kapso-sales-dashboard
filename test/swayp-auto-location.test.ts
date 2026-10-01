import {expect,it} from "vitest";
import {pilotLocationMatches} from "@/lib/swayp-auto-location";
it("requiere que el pin resuelva al mismo distrito de la misma provincia",()=>{
  const quote={couriers:[],ubigeo:{province:{name:"Arequipa"},district:{name:"Cayma"}}};
  expect(pilotLocationMatches("arequipa","Cayma",quote)).toBe(true);
  expect(pilotLocationMatches("arequipa","Cerro Colorado",quote)).toBe(false);
  expect(pilotLocationMatches("arequipa","Santiago",{couriers:[],ubigeo:{province:{name:"Cusco"},district:{name:"Santiago"}}})).toBe(false);
  expect(pilotLocationMatches("arequipa","Cayma",{couriers:[]})).toBe(false);
});
