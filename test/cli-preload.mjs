// This process is isolated by cli.test.ts; no retailer or browser traffic is allowed.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
globalThis.fetch = async (input, init) => {
  const url=new URL(String(input));
  if(process.env.TEST_REQUEST_LOG)appendFileSync(process.env.TEST_REQUEST_LOG,JSON.stringify({path:url.pathname,method:init?.method??'GET',body:init?.body})+'\n');
  let body;
  if(url.pathname.endsWith('/customer/profile'))body={user_id:'123456789',email:'dummy@example.invalid',store_number:'0123'};
  else if(url.pathname.endsWith('/slot/reservation'))body=null;
  else if(url.pathname.endsWith('/order/status'))body=null;
  else if (process.env.TEST_BASKET_STATE && (url.pathname.endsWith('/basket') || url.pathname.endsWith('/basket/item'))) {
    const basket=JSON.parse(readFileSync(process.env.TEST_BASKET_STATE,'utf8'));
    if(init?.method && init.method!=='GET'){
      const raw=JSON.parse(init.body);const change=raw.items?.[0]??raw;
      if(process.env.TEST_WRITE_MODE!=='mismatch'){
        let line=basket.items.find(i=>i.product.sku===change.product_uid);
        if(!line){line={item_uid:'line-1',quantity:0,uom:change.uom,selected_catchweight:change.selected_catchweight,product:{sku:change.product_uid,name:'Dummy product'},subtotal_price:0};basket.items.push(line);}
        line.quantity=change.quantity;line.subtotal_price=change.quantity*2;
        if(!line.quantity)basket.items=basket.items.filter(i=>i!==line);
        basket.total_price=basket.items.reduce((s,i)=>s+i.subtotal_price,0);basket.item_count=basket.items.length;
        writeFileSync(process.env.TEST_BASKET_STATE,JSON.stringify(basket),{mode:0o600});
      }
      return new Response(null,{status:204});
    }
    body=basket;
  }
  else if(url.pathname.endsWith('/basket'))body={basket_id:'basket-1',is_in_amend_mode:false,total_price:0,subtotal_price:0,minimum_spend:25,item_count:0,items:[]};
  else if(url.pathname.endsWith('/product'))body={products:[{product_uid:'12345',name:'Dummy product',is_available:true,retail_price:{price:2,measure:'ea'}}]};
  else throw new Error('Unexpected fake request');
  if(process.env.TEST_RESPONSE==='html')return new Response('<html>secret challenge</html>',{headers:{'content-type':'text/html'}});
  return new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});
};
