import { Command } from "commander";
import { getBasket, productUid } from "../../api/basket.js";
import { getSlotReservation } from "../../api/customer.js";
import { listSlots } from "../../api/slot.js";
import { createClient } from "../../client/factory.js";
import { buildContext, getFormat } from "../context.js";
import { exitCodeFor, printData, printError } from "../output.js";
export function slotCommand(): Command {
  const cmd = new Command("slot").description("Inspect slots; booking and changes are unavailable");
  cmd.command("current").action(async (_opts, ref)=>{
    try {const r=await getSlotReservation(await createClient());printData({format:getFormat(ref)},r??{reserved:false},()=>JSON.stringify(r));}
    catch(err){printError(err);process.exitCode=exitCodeFor(err);}
  });
  cmd.command("list").option("--week <n>", "Week number, 1 to 4", "1").action(async (opts, ref)=>{
    try {
      const week=Number(opts.week);if(!Number.isInteger(week)||week<1||week>4)throw new Error("Week must be 1 to 4");
      const c=await buildContext(ref);const basket=await getBasket(c.client,c.basketContext);
      const skus=basket.items.map(productUid);
      if(!skus.length||skus.some(s=>!s))throw new Error("Current basket needs numeric product SKUs to inspect availability");
      const r=await listSlots(c.client,{storeIdentifier:c.storeNumber,productUids:skus as string[],weekNumber:week,slotType:c.productContext.slotType==="collection"?"COLLECTION":"DELIVERY"});
      printData(c,r,()=>JSON.stringify(r));
    }catch(err){printError(err);process.exitCode=exitCodeFor(err);}
  });
  return cmd;
}
