/* Conviction Cloud shim: gives the board page the two things the Claude app used to provide.
   window.claude.use('mcp') -> market data through this server (Massive); use('db') -> this server's database, live. */
(function(){
  var CC = window.__CC || {}; var board = CC.board; var hdr = {'content-type':'application/json'};
  if (CC.engine && CC.token) hdr['x-engine'] = CC.token;
  window.__VIEWER = !CC.engine;
  function post(url, body){
    return fetch(url, {method:'POST', headers:hdr, body:JSON.stringify(body), credentials:'same-origin'}).then(function(r){
      return r.json().catch(function(){ return {}; }).then(function(j){ if(!r.ok || j.error) throw (j.error || {code:'error', message:'HTTP '+r.status}); return j; });
    }, function(e){ throw {code:'server_unavailable', message:'Cannot reach the board server: '+(e && e.message)}; });
  }
  // the server says with every reply whether its live stream is on; the boards read window.__CC.live to pick their pace
  var mcp = { callTool: function(server, tool, input){ return post('/api/mcp', {server:server, tool:tool, input:input||{}}).then(function(j){ if('live' in j) CC.live = !!j.live; return j.result; }); } };

  // database: collections cached here, refreshed by server push
  var cache = {}, subs = {}, es = null;
  function copy(x){ return x==null? x : JSON.parse(JSON.stringify(x)); }
  function fire(coll){ var docs = Object.keys(cache[coll]||{}).map(function(id){ var d=cache[coll][id]; return {id:id, data:function(){ return copy(d); }}; });
    (subs[coll]||[]).forEach(function(cb){ try{ cb({docs:docs}); }catch(e){ console.error(e); } }); }
  function load(coll){ return fetch('/api/db/'+board+'/'+coll, {credentials:'same-origin'}).then(function(r){ return r.json(); }).then(function(j){ cache[coll]=j.docs||{}; fire(coll); }); }
  function stream(){
    if (es) return; es = new EventSource('/api/events/'+board);
    es.onmessage = function(ev){ try{ var m=JSON.parse(ev.data); if(subs[m.coll]){ cache[m.coll]=m.docs||{}; fire(m.coll); } }catch(e){} };
    es.onerror = function(){ /* EventSource reconnects by itself; reload collections when it does */ };
    es.onopen = function(){ Object.keys(subs).forEach(function(c){ load(c).catch(function(){}); }); };
  }
  function write(coll, id, op, data){
    var c = cache[coll] = cache[coll] || {};
    if (op==='set') c[id]=copy(data); else if (op==='update'){ if(!c[id]) return Promise.reject({code:'not_found'}); c[id]=Object.assign({}, c[id], copy(data)); } else if (op==='delete') delete c[id];
    if (subs[coll]) setTimeout(function(){ fire(coll); }, 0);
    return post('/api/db/'+board+'/'+coll+'/'+encodeURIComponent(id), {op:op, data:data}).then(function(j){ if(j && j.ignored) load(coll).catch(function(){}); });
  }
  var db = { collection: function(coll){ return {
    doc: function(id){ return { set:function(d){ return write(coll,id,'set',d); }, update:function(d){ return write(coll,id,'update',d); }, delete:function(){ return write(coll,id,'delete'); } }; },
    onSnapshot: function(cb, err){ (subs[coll]=subs[coll]||[]).push(cb); stream(); load(coll).catch(function(e){ err && err({code:'unavailable', message:String(e)}); }); return function(){ subs[coll]=(subs[coll]||[]).filter(function(x){ return x!==cb; }); }; }
  }; } };
  window.claude = { use: function(n){ return Promise.resolve(n==='mcp'? mcp : n==='db'? db : null); } };
})();
