const {chromium}=require(process.env.PW_MODULE); const fs=require('fs');
(async()=>{ const b=await chromium.launch(); const ctx=await b.newContext({httpCredentials:{username:'bilal',password:'testpass'}, viewport:{width:1300,height:1000}});
  const libs=JSON.parse(process.env.TEST_LIBS); await ctx.route(/^https?:\/\/(?!192\.0\.2\.2)/, r=>{ const u=r.request().url(); for(const k in libs) if(u.endsWith(k)) return r.fulfill({body:fs.readFileSync(libs[k]),contentType:'application/javascript'}); return r.fulfill({body:''}); });
  const errs=[]; for(const bd of ['v3','v2']){ const p=await ctx.newPage(); p.on('pageerror',e=>errs.push(bd+': '+e.message)); await p.goto('http://192.0.2.2:8099/'+bd); await p.waitForTimeout(12000);
    if(bd==='v3'){ await p.getByRole('tab',{name:/^1-min/}).click(); await p.waitForTimeout(800); }
    await p.screenshot({path:'test/viewer-'+bd+'.png'}); console.log(bd, (await p.evaluate(()=>document.body.innerText)).replace(/\s+/g,' ').slice(0,500)); }
  const p=await ctx.newPage(); await p.goto('http://192.0.2.2:8099/'); await p.screenshot({path:'test/index.png'});
  console.log('errors', errs); await b.close(); })();
