// 66_modem_api.js -> Web Server version for Node JS Server Android
"use strict";

const https = require("https");
const http = require("http");
const net = require("net");

function parseArgs(argv) {
  const c = {port: Number(process.env.PORT || 3000), host: process.env.HOST || "127.0.0.1", token:"", cwd:""};
  for (let i=0;i<argv.length;i++) {
    const a=argv[i];
    if(a==="--port" && argv[i+1]) c.port=Number(argv[++i]);
    else if(a==="--host" && argv[i+1]) c.host=argv[++i];
    else if(a==="--token" && argv[i+1]) c.token=argv[++i];
    else if(a==="--cwd" && argv[i+1]) c.cwd=argv[++i];
  }
  if(c.cwd){try{process.chdir(c.cwd);}catch(e){console.error("[node] chdir:",e.message);}}
  return c;
}
const CONFIG=parseArgs(process.argv.slice(2));
let session_key=null;
let cookies={};
let running=false;
let logs=[];
let rawLogs=[];
let currentIP="";
let lastResult=null;
const MAX_LOGS=500;

function log(...a){
  const s=a.map(x=>typeof x==="string"?x:JSON.stringify(x)).join(" ");
  const line=`[${new Date().toLocaleTimeString("vi-VN",{hour12:false})}]\n${s}`; rawLogs.push(line); if(rawLogs.length>MAX_LOGS) rawLogs.shift();
  console.log(line);
}
function stepLog(...a){
  const s=a.map(x=>typeof x==="string"?x:JSON.stringify(x)).join(" ");
  const stamp=new Date().toLocaleTimeString("vi-VN",{hour12:false});
  const line=`[${stamp}]`+"\n"+s;
  console.log(line); logs.push(line); rawLogs.push(line); if(logs.length>MAX_LOGS) logs.shift(); if(rawLogs.length>MAX_LOGS) rawLogs.shift();
}
async function timedStep(name,action){
  const startedAt=Date.now();
  try{return await action();}
  finally{stepLog(`⏱ ${name}: ${((Date.now()-startedAt)/1000).toFixed(2)} giây`);}
}
function sleep(ms){return new Promise(resolve=>setTimeout(resolve,ms));}
function storeCookies(headers){
  const sc=headers["set-cookie"]||[];
  for(const c of sc){
    const first=c.split(";")[0], i=first.indexOf("=");
    if(i>0) cookies[first.slice(0,i)] = first.slice(i+1);
  }
}
function cookieHeader(){return Object.entries(cookies).map(([k,v])=>`${k}=${v}`).join("; ");}
function formEncode(obj){
  return Object.entries(obj).map(([k,v])=>`${encodeURIComponent(k)}=${encodeURIComponent(String(v ?? ""))}`).join("&");
}
function request(method,url,body="",headers={}){
  return new Promise((resolve,reject)=>{
    const started=Date.now(), u=new URL(url), h={...headers};
    const rawLine=m=>{const t=`[${new Date().toLocaleTimeString("vi-VN",{hour12:false})}]\n${m}`;rawLogs.push(t);if(rawLogs.length>MAX_LOGS)rawLogs.shift();};
    rawLine(`[API>] ${method} ${u.pathname}${u.search} body=${body?Buffer.byteLength(body)+" byte (đã ẩn)":"(trống)"}`);
    if(body) h["Content-Length"]=Buffer.byteLength(body);
    const ck=cookieHeader(); if(ck) h.Cookie=ck;
    const req=https.request({
      hostname:u.hostname, port:u.port||443, path:u.pathname+u.search,
      method, headers:h, rejectUnauthorized:false, timeout:30000
    },res=>{
      const chunks=[];
      res.on("data",c=>chunks.push(c));
      res.on("end",()=>{storeCookies(res.headers); const text=Buffer.concat(chunks).toString("utf8"); rawLine(`[API<] ${method} ${u.pathname}${u.search} => ${res.statusCode}; response=${Buffer.byteLength(text)} byte; ${Date.now()-started} ms`); resolve({status:res.statusCode,headers:res.headers,text});});
    });
    req.on("timeout",()=>req.destroy(new Error("TIMEOUT")));
    req.on("error",e=>{rawLine(`[API!] ${method} ${u.pathname}${u.search}: ${e.message}`);reject(e);});
    if(body) req.write(body);
    req.end();
  });
}

async function loginNormal(ip,password){
  const base=`https://${ip}/cgi-bin/luci`;
  const r=await request("POST",`${base}/login.cmd`,formEncode({user:"admin",pass:password}),{
    "Content-Type":"application/x-www-form-urlencoded; charset=UTF-8",
    "Accept":"*/*","Origin":`https://${ip}`,"X-Requested-With":"XMLHttpRequest",
    "Referer":`https://${ip}/index.html`
  });
  log("LOGIN HTTP:",r.status);
  if(r.status<200||r.status>=300) throw new Error(`HTTP ${r.status}`);
  let result; try{result=JSON.parse(r.text);}catch(e){throw new Error("LOGIN trả về không phải JSON: "+r.text.slice(0,300));}
  if(result.status!=="OK") throw new Error(`LOGIN FAIL: modem trả status=${result.status||"không rõ"}`);
  session_key=result.sessionKey;
  if(!session_key) throw new Error("LOGIN OK nhưng modem không trả sessionKey.");
  log("LOGIN OK");
}
async function loginFirstReset(ip,newPassword){
  if(!newPassword) throw new Error("Chưa nhập PASS MODEM MỚI.");
  const base=`https://${ip}/cgi-bin/luci`;
  log("[1] LOGIN MODEM MẶC ĐỊNH admin/admin");
  let r=await request("POST",`${base}/login.cmd`,formEncode({user:"admin",pass:"admin"}),{
    "Content-Type":"application/x-www-form-urlencoded; charset=UTF-8",
    "Accept":"*/*","Origin":`https://${ip}`,"X-Requested-With":"XMLHttpRequest",
    "Referer":`https://${ip}/`
  });
  log("LOGIN FIRST HTTP:",r.status);
  if(r.status<200||r.status>=300) throw new Error(`HTTP ${r.status}`);
  let result; try{result=JSON.parse(r.text);}catch(e){throw new Error("LOGIN FIRST trả về không phải JSON: "+r.text.slice(0,300));}
  if(result.status!=="OK") throw new Error(`LOGIN FIRST FAIL: modem trả status=${result.status||"không rõ"}`);
  if(String(result.firstlog)!=="1") throw new Error("Modem không ở trạng thái first-login.");
  log("FIRSTLOG = 1");
  log("[2] ĐỔI PASS FIRST LOGIN");
  r=await request("POST",`${base}/accesscontrolcfg.json`,formEncode({
    undefined:"",sessionKey:"factoryID",username:"admin",oldPass:"",newPass:newPassword,user_cur_log:"admin"
  }),{
    "Content-Type":"application/x-www-form-urlencoded; charset=UTF-8",
    "Accept":"*/*","Origin":`https://${ip}`,"X-Requested-With":"XMLHttpRequest",
    "Referer":`https://${ip}/first_access_control.html`
  });
  log("FIRST ACCESS HTTP:",r.status);
  if(r.status<200||r.status>=300) throw new Error(`HTTP ${r.status}`);
  try{result=JSON.parse(r.text);}catch(e){throw new Error("FIRST ACCESS trả về không phải JSON: "+r.text.slice(0,300));}
  if(result.status!=="OK") throw new Error(`ĐỔI PASS FIRST LOGIN FAIL: modem trả status=${result.status||"không rõ"}`);
  log("ĐỔI PASS OK");
  log("[3] LOGIN LẠI BẰNG PASSWORD MỚI");
  await loginNormal(ip,newPassword);
}
async function api(ip,path,data){
  if(!session_key) throw new Error("Chưa có sessionKey.");
  const base=`https://${ip}/cgi-bin/luci`;
  const payload={...data,sessionKey:session_key};
  const r=await request("POST",`${base}/${path}`,formEncode(payload),{
    "Content-Type":"application/x-www-form-urlencoded; charset=UTF-8",
    "Accept":"*/*","Origin":`https://${ip}`,"X-Requested-With":"XMLHttpRequest"
  });
  log(`${path}: HTTP ${r.status}`);
  if(r.status<200||r.status>=300) throw new Error(`HTTP ${r.status}`);
  let result; try{result=JSON.parse(r.text);}catch(e){throw new Error(`${path}: modem trả về không phải JSON: ${r.text.slice(0,300)}`);}
  if(result.sessionKey){session_key=result.sessionKey;log("Đã làm mới phiên xác thực.");}
  if(result.status==="fail authen") throw new Error(`${path}: fail authen`);
  return result;
}
async function setSlid(ip,slid){
  if(!slid) throw new Error("Chưa nhập SLID.");
  const result=await api(ip,"gponpasswd.json",{data:slid});
  if(!Object.prototype.hasOwnProperty.call(result,"sysInfoGponPassWd")) throw new Error(`SLID FAIL: modem không xác nhận cập nhật (status=${result.status||"không rõ"})`);
  log("SLID OK");
}
async function setPppoe(ip,user,pass){
  if(!user||!pass) throw new Error("Chưa nhập đủ PPPoE.");
  log("[PPPoE] ĐANG TẠO PPPoE MỚI...");
  const result=await api(ip,"sendwan.cmd",{
    enblEnetWan:"0",serviceName:"internet",vlanMuxId:"11",vlanMuxPr:"0",ntwkPrtcl:"0",
    pppUserName:user,pppPassword:pass,enblIpVer:"1",wanAddr6Type:"DHCP",
    ethMtu:"1492",enblFirewall:"1",enblNat:"1",serviceId:"0",wanIfName:"undefined"
  });
  if(result.status!=="OK") throw new Error(`PPPoE FAIL: modem trả status=${result.status||"không rõ"}`);
  log("PPPoE OK");
}
async function setWifi(ip,unit,ssid,password){
  const band=unit===1?"5G":"2.4G";
  if(!ssid||!password) throw new Error(`Chưa nhập đủ WiFi ${band}.`);
  log(`[WiFi ${band}] ĐANG CẤU HÌNH...`);
  const result=await api(ip,"wirelesscfg.json",{
    page:"ssid.asp",action:"Apply",wl_unit:String(unit),wl_radio:"1",wl_bssid:"0",
    wl_bss_enabled:"1",wl_ssid:ssid,wl_bss_maxassoc:"32",wl_closed:"0",
    sec_mode:"wpa_wpa2_psk",wl_wpa_psk:password,wl_mode:"null",wl_auth:"0",
    wl_auth_mode:"radius",wl_osenen:"0",wl_akm:"",wl_akm_wpa:"disabled",
    wl_akm_psk:"enabled",wl_akm_wpa2:"disabled",wl_akm_psk2:"enabled",
    wl_akm_brcm_psk:"disabled",wl_preauth:"disabled",wl_wep:"disabled",
    wl_crypto:"tkip aes",wl_radius_ipaddr:"0.0.0.0",wl_radius_port:"1812",wl_radius_key:"1234"
  });
  if(result.status!=="OK") throw new Error(`WIFI ${band} FAIL: modem trả status=${result.status||"không rõ"}`);
  log(`WIFI ${band} OK`);
}
async function configure(o){
  running=true; session_key=null; cookies={}; currentIP=o.ip; lastResult=null;
  const warnings=[];
  logs=[];
  try{
    stepLog("Bắt đầu cấu hình modem");
    if(net.isIP(String(o.ip||""))!==4) throw new Error("IP modem phải là địa chỉ IPv4 hợp lệ.");
    const mode=String(o.mode||"1"), doSlid=queryBool(o.doSlid), doPppoe=queryBool(o.doPppoe);
    const doWifi5g=queryBool(o.doWifi5g)||queryBool(o.doWifi), doWifi2g=queryBool(o.doWifi2g)||queryBool(o.doWifi);
    if(!["1","2"].includes(mode)) throw new Error("Chế độ đăng nhập chỉ là 1 hoặc 2.");
    if(!o.modemPass) throw new Error("Chưa nhập mật khẩu modem.");
    if(doSlid&&!o.slid) throw new Error("Đã bật SLID nhưng chưa nhập SLID.");
    if(doPppoe&&(!o.pppoeUser||!o.pppoePass)) throw new Error("PPPoE cần có cả tài khoản và mật khẩu.");
    if(doWifi2g&&(!o.wifi2g||String(o.pass2g||"").length<8)) throw new Error("Wi-Fi 2.4 GHz cần tên mạng và mật khẩu tối thiểu 8 ký tự.");
    if(doWifi5g&&(!o.wifi5g||String(o.pass5g||"").length<8)) throw new Error("Wi-Fi 5 GHz cần tên mạng và mật khẩu tối thiểu 8 ký tự.");

    stepLog(mode==="1"?"1/4 Login: POST login.cmd mặc định → POST đổi mật khẩu → POST đăng nhập lại":"1/4 Login: POST login.cmd xác thực");
    await timedStep("Login",async()=>{
      if(mode==="1") await loginFirstReset(o.ip,o.modemPass||"");
      else await loginNormal(o.ip,o.modemPass||"");
    });
    stepLog("1/4 Đăng nhập modem: xong");
    await sleep(1000);

    if(doSlid){
      stepLog("2/4 SLID: POST gponpasswd.json");
      await timedStep("SLID",()=>setSlid(o.ip,o.slid));
      stepLog("2/4 SLID: xong");
    }else stepLog("2/4 SLID: bỏ qua");
    await sleep(1000);

    if(doPppoe){
      stepLog("3/4 PPPoE: POST sendwan.cmd tạo kết nối");
      try{
        await timedStep("PPPoE",()=>setPppoe(o.ip,o.pppoeUser,o.pppoePass));
        stepLog("3/4 PPPoE: xong");
      }catch(e){
        const warning=`PPPoE không hoàn tất: ${e.message||e}`; warnings.push(warning);
        stepLog("⚠️",warning); stepLog("Tiếp tục các bước còn lại.");
      }
    }else stepLog("3/4 PPPoE: bỏ qua");
    await sleep(1000);

    if(doWifi5g){
      stepLog("4/4 Wi-Fi 5 GHz: POST wirelesscfg.json");
      try{
        await timedStep("Wi-Fi 5 GHz",()=>setWifi(o.ip,1,o.wifi5g,o.pass5g));
        stepLog("4/4 Wi-Fi 5 GHz: xong");
      }catch(e){
        const warning=`Wi-Fi 5 GHz không hoàn tất: ${e.message||e}`; warnings.push(warning); stepLog("⚠️",warning);
      }
    }else stepLog("4/4 Wi-Fi 5 GHz: bỏ qua");

    if(doWifi2g){
      if(doWifi5g) await sleep(1000);
      stepLog("4/4 Wi-Fi 2.4 GHz: POST wirelesscfg.json");
      try{
        await timedStep("Wi-Fi 2.4 GHz",()=>setWifi(o.ip,0,o.wifi2g,o.pass2g));
        stepLog("4/4 Wi-Fi 2.4 GHz: xong");
      }catch(e){
        const warning=`Wi-Fi 2.4 GHz không hoàn tất: ${e.message||e}`; warnings.push(warning); stepLog("⚠️",warning);
      }
    }else stepLog("4/4 Wi-Fi 2.4 GHz: bỏ qua");

    stepLog("Hoàn tất cấu hình");
    lastResult={ok:true,warnings};
  }catch(e){
    lastResult={ok:false,error:e.message||String(e)};
    stepLog("LỖI:",lastResult.error);
  }finally{
    session_key=null; cookies={}; running=false;
  }
}
function json(res,obj,status=200){
  const b=Buffer.from(JSON.stringify(obj));
  res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Content-Length":b.length});
  res.end(b);
}
const NS_V2_EMBED = process.env.NS_EMBED === '1';

function html(res){
  const API_PREFIX = NS_V2_EMBED ? '/nsv2' : '';
  const body=Buffer.from(`<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>Cấu hình Modem NS</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#101214;color:#f2f4f7;font-family:Arial,sans-serif;font-size:18px}
.wrap{max-width:760px;margin:auto;padding:12px}
.card{background:#1b1f23;border:1px solid #343a40;border-radius:18px;padding:16px;margin-bottom:12px;box-shadow:0 4px 18px #0006}
.header{padding:18px}.header h1{font-size:26px;margin:0 0 7px}.muted{color:#aeb6bf;font-size:14px;line-height:1.45}
.section-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px}.section-head .section-title{margin:0}.step-toggle{display:flex;align-items:center;gap:8px;margin:0;white-space:nowrap;font-size:14px;font-weight:700;color:#fff}.step-toggle input[type="checkbox"]{appearance:auto;-webkit-appearance:checkbox;width:18px;height:18px;margin:0;padding:0;flex:none}.step-toggle span{min-width:54px}.section-title{font-size:20px;font-weight:700;color:#8fc7ff;margin:0 0 12px}
.step{display:inline-block;min-width:30px;margin-right:7px;color:#fff}
label{display:block;margin:11px 0 5px;font-weight:700}
input,select{width:100%;padding:14px;border-radius:12px;border:1px solid #555;background:#111418;color:#fff;font-size:18px}
input:focus,select:focus{outline:2px solid #5b9cff}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.check{display:flex;align-items:center;gap:10px;margin:13px 0 3px;font-weight:700}
.check input{width:24px;height:24px;margin:0}
button{width:100%;padding:15px;border:0;border-radius:13px;font-size:19px;font-weight:700;margin-top:9px;background:#3478f6;color:#fff}
button:disabled{opacity:.45}
.danger{background:#c83d4f}
.status{padding:12px;border-radius:12px;background:#111418;margin-top:10px;white-space:pre-wrap;min-height:48px;font-weight:700}
.ok{color:#73e2a3}.err{color:#ff7b8d}.running{color:#ffd166}
.log{height:300px;overflow:auto;font:14px monospace;line-height:1.45;white-space:pre-wrap;background:#0b0d0f;padding:12px;border-radius:12px}.log-tools{display:flex;flex-direction:column;gap:8px;margin:8px 0 12px}.log-modes,.log-actions{display:flex;align-items:center;gap:12px}.log-mode{display:flex!important;align-items:center;gap:8px;margin:0!important;font-size:18px;white-space:nowrap}.log-mode input[type=radio]{width:24px!important;height:24px;margin:0;flex:none}.log-actions{width:100%}.log-actions button{width:50%!important;flex:1;margin:0;padding:12px 8px;font-size:18px}
.note{margin-top:8px;color:#aeb6bf;font-size:13px;line-height:1.4}
@media(max-width:520px){.grid{grid-template-columns:1fr}body{font-size:17px}.wrap{padding:9px}.card{padding:14px}.header h1{font-size:24px}}
#status{display:none!important}</style></head><body><div class="wrap">
<div class="card header">
  <h1>[Trần Trung Hiếu]</h1><h2>MODEM GPON NS_V2</h2>
  
  
</div>

<div class="card">
  <div class="section-title"><span class="step">1.</span>ĐĂNG NHẬP MODEM</div>
  <div class="grid">
    <div><label>Địa chỉ IP modem</label><input id="ip" value="192.168.1.1"></div>
    <div><label>Tài khoản quản trị</label><input value="admin" disabled></div>
  </div>
  <label>Chế độ đăng nhập modem</label>
  <select id="mode">
    <option value="1">1 - Modem vừa reset / đăng nhập admin/admin</option>
    <option value="2">2 - Modem đã đổi mật khẩu</option>
  </select>
  <label id="passwordLabel">Mật khẩu mới</label><input id="modemPass"  value="" placeholder="Nhập mật khẩu mới cho modem">
</div>

<div class="card">
  <div class="section-head"><div class="section-title"><span class="step">2.</span>SLID GPON</div><label class="step-toggle"><input id="doSlid" type="checkbox" checked onchange="this.nextElementSibling.textContent=this.checked?'Enable':'Disable'"><span>Enable</span></label></div>
  <label>SLID GPON</label><input id="slid" value="A00012345">
</div>

<div class="card">
  <div class="section-head"><div class="section-title"><span class="step">3.</span>CẤU HÌNH WAN PPPoE</div><label class="step-toggle"><input id="doPppoe" type="checkbox" checked onchange="this.nextElementSibling.textContent=this.checked?'Enable':'Disable'"><span>Enable</span></label></div>
  <div class="grid">
    <div><label>Tài khoản PPPoE</label><input id="pppoeUser" value="ppp_user"></div>
    <div><label>VLAN WAN</label><input value="11" disabled></div>
  </div>
  <label>Mật khẩu PPPoE</label><input id="pppoePass" value="abcd1234">
  
</div>

<div class="card">
  <div class="section-title"><span class="step">4.</span>WIFI</div>
  <div class="grid">
    <div><div class="section-head"><div class="section-title">WiFi 2.4 GHz</div><label class="step-toggle"><input id="doWifi2g" type="checkbox" checked onchange="this.nextElementSibling.textContent=this.checked?'Enable':'Disable'"><span>Enable</span></label></div><label>Tên WiFi 2.4 GHz</label><input id="wifi2g" value="WiFi 2.4G"><label>Mật khẩu WiFi 2.4 GHz</label><input id="pass2g" value="1234567890"></div>
    <div><div class="section-head"><div class="section-title">WiFi 5 GHz</div><label class="step-toggle"><input id="doWifi5g" type="checkbox" checked onchange="this.nextElementSibling.textContent=this.checked?'Enable':'Disable'"><span>Enable</span></label></div><label>Tên WiFi 5 GHz</label><input id="wifi5g" value="WiFi 5G"><label>Mật khẩu WiFi 5 GHz</label><input id="pass5g" value="1234567890"></div>
  </div>
</div>

<div class="card">
  <button class="run" id="run">▶ BẮT ĐẦU CẤU HÌNH</button>
  <div id="status" class="status">Sẵn sàng.</div>
</div>

<div class="card">
    <div class="log-tools" id="logControls"><div class="log-modes"><label class="log-mode"><input type="radio" name="logMode" value="quick" checked> Log</label><label class="log-mode"><input type="radio" name="logMode" value="raw"> Log RAW</label></div><div class="log-actions"><button type="button" id="copyLogs">Copy</button><button type="button" id="clearLogs">Del</button></div></div>
  <pre id="logs" class="log">Chưa có log.</pre>
</div>
</div>
<script>
(function(){
  "use strict";
  var $=function(id){return document.getElementById(id);};
  function val(id){return $(id).value.trim();}
  function checked(id){return $(id).checked;}
  async function refresh(){
    try{
      var r=await fetch('${API_PREFIX}/api/status',{cache:"no-store"});
      var d=await r.json();
      var shown=document.querySelector("input[name=logMode]:checked").value==="raw"?d.rawLogs:d.logs;
      $("logs").textContent=(shown&&shown.length)?shown.join("\\n"):"Chưa có log.";
      $("status").textContent=d.running?"⏳ ĐANG CẤU HÌNH...":(d.result&&d.result.ok===false?"❌ "+d.result.error:(d.result&&d.result.warnings&&d.result.warnings.length?"⚠️ Hoàn tất nhưng có bước bị bỏ qua.":(d.result?"✅ Cấu hình hoàn tất":"Sẵn sàng.")));
      $("status").className=d.running?"status running":(d.result&&d.result.ok===false?"status err":"status ok");
      $("run").disabled=!!d.running;
      if(d.running) setTimeout(refresh,700);
    }catch(e){
      $("status").textContent="❌ Không kết nối được API: "+e.message;
      $("status").className="status err";
    }
  }
  function updatePasswordLabel(){
    var mode=$("mode").value, label=$("passwordLabel"), input=$("modemPass");
    if(mode==="1"){
      label.textContent="Mật khẩu mới";
      input.placeholder="Nhập mật khẩu mới cho modem";
    }else{
      label.textContent="Mật khẩu hiện tại";
      input.placeholder="Nhập mật khẩu hiện tại của modem";
    }
  }
  $("mode").addEventListener("change",updatePasswordLabel);
  updatePasswordLabel();
  $("run").addEventListener("click",async function(){
    var payload={
      ip:val("ip"),mode:$("mode").value,modemPass:val("modemPass"),slid:val("slid"),
      pppoeUser:val("pppoeUser"),pppoePass:val("pppoePass"),
      wifi2g:val("wifi2g"),pass2g:val("pass2g"),wifi5g:val("wifi5g"),pass5g:val("pass5g"),
      doSlid:checked("doSlid"),doPppoe:checked("doPppoe"),doWifi2g:checked("doWifi2g"),doWifi5g:checked("doWifi5g")
    };
    $("status").textContent="⏳ Đang gửi yêu cầu cấu hình...";
    $("status").className="status running";
    try{
      var r=await fetch('${API_PREFIX}/api/configure',{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
      var d=await r.json();
      if(!d.ok) throw new Error(d.error||"Không thể bắt đầu");
      await refresh();
    }catch(e){
      $("status").textContent="❌ LỖI: "+e.message;
      $("status").className="status err";
    }
  });
  document.querySelectorAll("input[name=logMode]").forEach(function(el){el.addEventListener("change",refresh);});
  $("copyLogs").addEventListener("click",async function(){var t=$("logs").textContent;try{await navigator.clipboard.writeText(t);}catch(e){var x=document.createElement("textarea");x.value=t;document.body.appendChild(x);x.select();document.execCommand("copy");x.remove();}});
  $("clearLogs").addEventListener("click",async function(){await fetch('${API_PREFIX}/api/logs/clear',{method:'POST',cache:'no-store'});refresh();});
  fetch('${API_PREFIX}/api/logs/clear',{method:'POST',cache:'no-store'}).then(refresh).catch(refresh);
})();
</script></body></html>`);
  res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Content-Length":body.length});
  res.end(body);
}

function readBody(req){
  return new Promise((resolve,reject)=>{
    let s=""; req.on("data",c=>{s+=c;if(s.length>1024*1024) req.destroy();});
    req.on("end",()=>resolve(s)); req.on("error",reject);
  });
}
function queryBool(value){
  return ["1","true","yes","on"].includes(String(value||"").toLowerCase());
}
function configurePageV2(res){
  const prefix=NS_V2_EMBED?"/nsv2":"";
  const body=`<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>NS V2 - Nhật ký cấu hình</title><style>
  *{box-sizing:border-box}body{margin:0;background:#101418;color:#eef2f6;font:16px Arial,sans-serif}main{max-width:850px;margin:24px auto;padding:12px}.log-tools{display:flex;flex-direction:column;gap:8px;margin:8px 0 12px}.log-modes,.log-actions{display:flex;align-items:center;gap:12px}.log-mode{display:flex!important;align-items:center;gap:8px;margin:0!important;font-size:18px;white-space:nowrap}.log-mode input[type=radio]{width:24px!important;height:24px;margin:0;flex:none}.log-actions{width:100%}.log-actions button{width:50%!important;flex:1;margin:0;padding:12px 8px;font-size:18px}.log-actions button{background:#3478f6;color:#fff;border:0;border-radius:9px;font-weight:bold}
  .card{background:#1b222a;border:1px solid #35404c;border-radius:14px;padding:18px}h2{margin:0 0 8px;font-size:22px}.muted{color:#aab6c2;font-size:13px}
  .status{margin:14px 0;padding:12px;border-radius:9px;background:#111820;color:#ffd166;font-weight:bold}pre{margin:0;height:65vh;min-height:300px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;background:#080c10;border-radius:9px;padding:14px;color:#d8e4ef;font:13px/1.55 Consolas,monospace}
  @media(max-width:600px){main{margin:0;padding:8px}.card{padding:12px}pre{height:72vh}}
  #status{display:none!important}</style></head><body><main><section class="card"><h2>📋 CẤU HÌNH MODEM NS V2</h2><div class="muted">Nhật ký cập nhật tự động. Không đóng trang trong khi modem đang cấu hình.</div><div id="status" class="status">Đang kết nối...</div><div class="log-tools" id="logControls"><div class="log-modes"><label class="log-mode"><input type="radio" name="logMode" value="quick" checked> Log</label><label class="log-mode"><input type="radio" name="logMode" value="raw"> Log RAW</label></div><div class="log-actions"><button type="button" id="copyLogs">Copy</button><button type="button" id="clearLogs">Del</button></div></div><pre id="logs">Đang chờ nhật ký...</pre></section></main>
  <script>(function(){try{history.replaceState(null,'',location.pathname+'?view=1')}catch(e){}const s=document.getElementById('status'),l=document.getElementById('logs');async function refresh(){try{const r=await fetch('${prefix}/api/status',{cache:'no-store'});const d=await r.json(),a=document.querySelector('input[name=logMode]:checked').value==='raw'?d.rawLogs:d.logs;l.textContent=a&&a.length?a.join('\\n'):'Chưa có nhật ký.';s.textContent=d.running?'⏳ ĐANG CẤU HÌNH MODEM...':(d.result&&d.result.ok===false?'❌ CẤU HÌNH CÓ LỖI':(d.result&&d.result.warnings&&d.result.warnings.length?'⚠️ HOÀN TẤT NHƯNG CÓ BƯỚC BỊ BỎ QUA':'✅ ĐÃ DỪNG / HOÀN TẤT'));l.scrollTop=l.scrollHeight}catch(e){s.textContent='Mất kết nối nhật ký: '+e.message}}document.querySelectorAll('input[name=logMode]').forEach(x=>x.addEventListener('change',refresh));document.getElementById('copyLogs').addEventListener('click',async()=>{const t=l.textContent;try{await navigator.clipboard.writeText(t)}catch(e){const x=document.createElement('textarea');x.value=t;document.body.appendChild(x);x.select();document.execCommand('copy');x.remove()}});document.getElementById('clearLogs').addEventListener('click',async()=>{await fetch('${prefix}/api/logs/clear',{method:'POST'});refresh()});refresh();setInterval(refresh,1000)})();</script>
  </body></html>`;
  res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","Content-Length":Buffer.byteLength(body)});res.end(body);
}
function configFromQueryV2(p){
  return {
    ip:p.get("ip")||"192.168.1.1", mode:p.get("mode")||p.get("loginMode")||"1",
    modemPass:p.get("modemPass")||p.get("password")||"", slid:p.get("slid")||"",
    pppoeUser:p.get("pppoeUser")||"", pppoePass:p.get("pppoePass")||p.get("pppoePassword")||"",
    wifi2g:p.get("wifi2g")||p.get("wifi2gName")||"WiFi 2.4G", pass2g:p.get("pass2g")||p.get("wifi2gPassword")||"",
    wifi5g:p.get("wifi5g")||p.get("wifi5gName")||"WiFi 5G", pass5g:p.get("pass5g")||p.get("wifi5gPassword")||"",
    doSlid:queryBool(p.get("doSlid")), doPppoe:queryBool(p.get("doPppoe")), doWifi:queryBool(p.get("doWifi")), doWifi2g:queryBool(p.get("doWifi2g"))||queryBool(p.get("doWifi")), doWifi5g:queryBool(p.get("doWifi5g"))||queryBool(p.get("doWifi"))
  };
}
function startConfigureFromUrlV2(res,u){
  if(running)return htmlMessageV2(res,"Đang có một cấu hình khác chạy. Hãy chờ hoàn tất.");
  const data=configFromQueryV2(u.searchParams);
  if(!data.ip||!data.modemPass)return htmlMessageV2(res,"Thiếu tham số bắt buộc: ip và modemPass (mật khẩu modem).");
  if(!["1","2"].includes(data.mode))return htmlMessageV2(res,"mode chỉ nhận 1 hoặc 2.");
  // configure() tự đặt running=true trước lần await đầu tiên.
  configure(data);
  return configurePageV2(res);
}
function htmlMessageV2(res,message){
  const body='<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><h3>'+String(message).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))+'</h3>';
  res.writeHead(400,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store"});res.end(body);
}

const server=http.createServer(async(req,res)=>{
  try{
    const u=new URL(req.url,`http://${req.headers.host||"127.0.0.1"}`);
    if(req.method==="GET" && u.pathname==="/configure"){
      if(u.searchParams.get("view")==="1")return configurePageV2(res);
      return startConfigureFromUrlV2(res,u);
    }
    if(req.method==="GET" && u.pathname==="/"){return html(res);}
    if(req.method==="GET" && u.pathname==="/api/status"){return json(res,{ok:true,running,logs,rawLogs,result:lastResult});}
    if(req.method==="POST" && u.pathname==="/api/logs/clear"){logs=[];rawLogs=[];lastResult=null;return json(res,{ok:true});}
    if(req.method==="POST" && u.pathname==="/api/configure"){
      if(running) return json(res,{ok:false,error:"Đang có một cấu hình khác đang chạy."},409);
      const raw=await readBody(req); let data;
      try{data=JSON.parse(raw);}catch(e){return json(res,{ok:false,error:"JSON không hợp lệ."},400);}
      configure(data);
      return json(res,{ok:true});
    }
    res.writeHead(404);res.end("Not found");
  }catch(e){console.error(e);json(res,{ok:false,error:e.message||String(e)},500);}
});
server.on("error",e=>{console.error("[node] server error:",e);process.exitCode=1;});
process.on("uncaughtException",e=>console.error("[node] uncaught exception:",e));
if (!process.env.NS_EMBED) {
  server.listen(CONFIG.port, CONFIG.host, () =>
    console.log(`[node] listening on http://${CONFIG.host}:${CONFIG.port}`)
  );
}

module.exports = { server };

