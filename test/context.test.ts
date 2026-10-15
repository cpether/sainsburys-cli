import { test } from "node:test";
import assert from "node:assert/strict";
import { GroceriesClient } from "../src/client/http.js";
import { resolveShoppingContext } from "../src/api/context.js";
import { getSlotReservation } from "../src/api/customer.js";
import { getActiveOrderStatus } from "../src/api/order.js";
import { listCoupons } from "../src/api/coupon.js";
import { getProductsByUid } from "../src/api/product.js";
import { fakeSession, makeFakeFetch } from "./_helpers.js";
const future = "2099-10-15T10:00:00Z";
const reservation={is_expired:false,reservation_type:"delivery",store_identifier:"0123",region:"Scotland",flexi_stores:["0123"],reserved_until:future,slot:{start_time:future,end_time:"2099-10-15T11:00:00Z",price:1,booking_key:"dummy",reservation_id:"reservation-1",slot_type:"1hour"}};
function client(bodies: unknown[]){const f=makeFakeFetch(bodies.map(body=>({body})));return {client:new GroceriesClient({session:fakeSession(),baseUrl:"https://www.sainsburys.co.uk",fetchImpl:f.fetch}),calls:f.calls};}
test("actual reservation overrides cached store and carries delivery context",async()=>{
  const c=client([{user_id:123456789,store_number:"9999"},reservation]);
  const ctx=await resolveShoppingContext(c.client);
  assert.deepEqual(ctx.basketContext,{storeNumber:"0123",slotBooked:true,pickTime:future});
  assert.equal(ctx.productContext.region,"Scotland");assert.equal(ctx.productContext.slotDate,"2099-10-15");assert.equal(ctx.reservationId,"reservation-1");
});
test("explicit store override wins and missing context fails closed",async()=>{
  let c=client([{user_id:"123456789"},reservation]);assert.equal((await resolveShoppingContext(c.client,"9876")).basketContext.storeNumber,"9876");
  c=client([{user_id:"123456789"},null]);await assert.rejects(resolveShoppingContext(c.client));
});
test("account home store used without a reservation, expired reservation not booked",async()=>{
  let c=client([{user_id:"123456789",store_number:"4567"},null]);assert.deepEqual((await resolveShoppingContext(c.client)).basketContext,{storeNumber:"4567",slotBooked:false});
  c=client([{user_id:"123456789"},{...reservation,is_expired:true}]);assert.equal((await resolveShoppingContext(c.client)).basketContext.slotBooked,false);
});
test("wrong account and malformed reservation/status cannot become absent state",async()=>{
  let c=client([{user_id:"different"}]);await assert.rejects(resolveShoppingContext(c.client));
  c=client([{}]);await assert.rejects(getSlotReservation(c.client));
  c=client([{}]);await assert.rejects(getActiveOrderStatus(c.client));
  c=client([null]);assert.equal(await getActiveOrderStatus(c.client),null);
});
test("coupon and product schema failures propagate",async()=>{
  let c=client([{}]);await assert.rejects(listCoupons(c.client));
  c=client([{coupons:[]}]);assert.deepEqual(await listCoupons(c.client),{coupons:[]});
  c=client([{products:[{product_uid:123,name:"Dummy",retail_price:{price:2}}]}]);const r=await getProductsByUid(c.client,{uids:["123"],ctx:{storeIdentifier:"0123"}});assert.equal(r.products[0]!.product_uid,"123");
  c=client([{products:[{name:"Invalid"}]}]);await assert.rejects(getProductsByUid(c.client,{uids:["123"],ctx:{storeIdentifier:"0123"}}));
});

test("expired or reversed reservation times cannot be active context",async()=>{
  let c=client([{user_id:"123456789"},{...reservation,slot:{...reservation.slot,start_time:"2001-01-01T10:00:00Z",end_time:"2001-01-01T11:00:00Z"}}]);
  assert.equal((await resolveShoppingContext(c.client)).basketContext.slotBooked,false);
  c=client([{...reservation,slot:{...reservation.slot,end_time:"2001-01-01T11:00:00Z"}}]);await assert.rejects(getSlotReservation(c.client));
});

test("product slot overrides drop contradictory datetime and validate dates/types",async()=>{
  const {productContextFromOptions}=await import("../src/cli/commands/product.js");
  const base={storeIdentifier:"0123",slotDate:"2099-10-15",slotDatetime:future,slotType:"delivery" as const};
  assert.equal(productContextFromOptions(base,{slotDate:"2099-10-16"}).slotDatetime,undefined);
  assert.equal(productContextFromOptions(base,{slotType:"collection"}).slotDatetime,undefined);
  assert.equal(productContextFromOptions(base,{slotDate:"2099-10-15"}).slotDatetime,future);
  assert.throws(()=>productContextFromOptions(base,{slotDate:"2099-02-30"}));assert.throws(()=>productContextFromOptions(base,{slotType:"anything"}));
});
