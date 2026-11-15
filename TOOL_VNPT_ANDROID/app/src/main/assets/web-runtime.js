/* Browser-side compatibility layer for the supplied backend logic.
 * No Node.js runtime/server is shipped. HTTPS sockets are executed by Java/OkHttp.
 */
(function () {
  'use strict';
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  class NodeBuffer extends Uint8Array {
    static from(v, encoding) {
      if (v instanceof Uint8Array) return new NodeBuffer(v);
      if (Array.isArray(v)) return new NodeBuffer(v);
      if (encoding === 'base64') return new NodeBuffer(Uint8Array.from(atob(String(v)), c => c.charCodeAt(0)));
      return new NodeBuffer(enc.encode(String(v)));
    }
    static byteLength(v) { return enc.encode(String(v)).length; }
    static concat(list) { let n=0; list.forEach(x=>n+=x.length); const out=new NodeBuffer(n); let p=0; list.forEach(x=>{out.set(x,p);p+=x.length;}); return out; }
    toString(encoding) {
      if (encoding === 'base64') { let s=''; this.forEach(b=>s+=String.fromCharCode(b)); return btoa(s); }
      return dec.decode(this);
    }
  }
  window.Buffer = NodeBuffer;
  window.process = { env: { NS_EMBED:'', G040H_EMBED:'', PORT:'3000', HOST:'127.0.0.1' }, argv:[], exitCode:0, on(){}, chdir(){} };
  window.module = { exports:{} };
  const servers = [];
  function emitter() {
    const events = {};
    return { on(name, fn){(events[name] ||= []).push(fn);return this;}, has(name){return !!(events[name]&&events[name].length);}, emit(name,...args){(events[name]||[]).forEach(fn=>{try{fn(...args)}catch(e){setTimeout(()=>{throw e},0)}});}, setEncoding(){}, destroy(err){if(err)this.emit('error',err);} };
  }
  function normalizeHeaders(h) {
    const out={}; Object.keys(h||{}).forEach(k=>{const key=k.toLowerCase();out[key]=h[k];}); return out;
  }
  const https = {
    Agent: function Agent() {},
    request(options, callback) {
      const req=emitter(); let body=''; let sent=false; let completed=false; let timer=null;
      req.destroy = err => { completed=true; if(timer)clearTimeout(timer); if(err)req.emit('error',err); };
      if(options.timeout) timer=setTimeout(()=>{if(!completed)req.emit('timeout');},options.timeout);
      req.write = chunk => { body += chunk instanceof Uint8Array ? dec.decode(chunk) : String(chunk); };
      req.end = chunk => {
        if (chunk != null) req.write(chunk); if(sent)return; sent=true;
        const host=options.hostname || options.host || '';
        const url='https://'+host+(options.port && Number(options.port)!==443?':'+options.port:'')+(options.path||'/');
        const isModem=/^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(host) || host==='localhost';
        window.nativeHttps(url,{method:options.method||'GET',headers:options.headers||{},body,modem:isModem}).then(async r=>{
          if(completed)return;
          const text=await r.text(); completed=true; if(timer)clearTimeout(timer);
          const headers=normalizeHeaders(r.headers||{});
          if (headers['set-cookie'] && !Array.isArray(headers['set-cookie'])) headers['set-cookie']=[headers['set-cookie']];
          const response=emitter(); response.statusCode=r.status; response.headers=headers;
          if(callback) callback(response);
          setTimeout(()=>{ if(text) response.emit('data',NodeBuffer.from(text)); if(r.aborted){if(response.has('aborted'))response.emit('aborted');else req.emit('error',new Error('Phản hồi HTTPS bị ngắt giữa chừng'));}else response.emit('end'); },0);
        }).catch(e=>{if(completed)return;completed=true;if(timer)clearTimeout(timer);req.emit('error',e);});
      };
      req.setTimeout = ms => { if(timer)clearTimeout(timer); timer=setTimeout(()=>{if(!completed)req.emit('timeout');},ms||30000);return req; };
      return req;
    }
  };
  const http = {
    createServer(handler) {
      const server={handler,listen(){return server;},on(){return server;}}; servers.push(server); return server;
    }
  };
  const net = { isIP(v) { const s=String(v||''); if(/^\d{1,3}(\.\d{1,3}){3}$/.test(s) && s.split('.').every(x=>+x<=255)) return 4; return 0; } };
  const fs = { appendFileSync(){}, readFile(file,cb){cb(new Error('Static file serving is disabled in WebView'),null);} };
  const path = { join:(...a)=>a.join('/'), extname:p=>{const m=String(p).match(/(\.[^.\/]+)$/);return m?m[1]:'';}, resolve:(...a)=>a.join('/'), sep:'/' };
  window.require = name => ({https,http,net,fs,path,url:{URL}}[name] || {});
  window.__nodeDispatch = async function(input, init={}) {
    const url=new URL(typeof input==='string'?input:input.url, location.href);
    const server=servers[servers.length-1];
    if(!server) throw new Error('Module backend chưa khởi tạo');
    const method=String(init.method||'GET').toUpperCase();
    const rawHeaders=init.headers||{}; const headers={host:'localhost',...normalizeHeaders(rawHeaders)};
    const body=init.body==null?'':String(init.body);
    const req=emitter(); req.method=method;req.url=url.pathname+url.search;req.headers=headers;
    req.setEncoding=()=>{};
    const response={status:200,headers:{},body:'',writeHead(code,h){this.status=code;this.headers=h||{};},setHeader(k,v){this.headers[k]=v;},end(v){this.body=v instanceof Uint8Array?dec.decode(v):String(v==null?'':v);this.finished=true;}};
    const res=response;
    const run=Promise.resolve().then(()=>server.handler(req,res));
    // Stream the incoming request body only after route code has attached listeners.
    await Promise.resolve();
    if(body) req.emit('data',body);
    req.emit('end');
    await run;
    const text=res.body||'';
    return {ok:res.status>=200&&res.status<300,status:res.status,headers:res.headers,text:async()=>text,json:async()=>JSON.parse(text)};
  };
  const nativeFetch=window.fetch.bind(window);
  window.fetch=function(input,init={}){
    const u=new URL(typeof input==='string'?input:input.url,location.href);
    if(u.origin===location.origin && !u.pathname.startsWith('/api/')) return window.__nodeDispatch(input,init);
    if(u.origin===location.origin && u.pathname.startsWith('/api/')) return window.__nodeDispatch(input,init);
    return nativeFetch(input,init);
  };
  window.__nodeOpen = async function() {
    const r=await window.__nodeDispatch('/',{method:'GET'});
    const html=await r.text();
    document.open(); document.write(html); document.close();
  };
})();
