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
<style>*{box-sizing:border-box}:root{font-family:Arial,sans-serif;color:#101d34}body{margin:0;background:#edf5ff;color:#111c30;font-family:Arial,sans-serif;font-size:16px}.wrap{max-width:1120px;margin:auto;padding:0 12px 16px}.appbar{height:76px;margin:0 -12px 12px;padding:0 18px;display:flex;align-items:center;gap:14px;background:linear-gradient(100deg,#052c55,#063e7b);color:#fff;box-shadow:0 3px 12px #00152e35}.appbar button.back{width:42px!important;flex:none;margin:0!important;padding:4px!important;background:transparent!important;color:#fff;font-size:34px!important}.appbar .router{font-size:30px}.appbar strong{font-size:clamp(20px,4vw,32px);font-weight:800;flex:1}.appbar .menu-home{width:auto!important;margin:0!important;padding:9px 14px!important;border:1px solid #ffffff80!important;border-radius:10px!important;background:#ffffff13!important;color:#fff;font-size:14px!important}.card{overflow:hidden;background:#f8fbff;border:2px solid #0b5bb8;border-radius:18px;padding:0;margin:11px 0;box-shadow:0 4px 10px #144c831a}.card-head{min-height:52px;padding:8px 17px;display:flex;align-items:center;justify-content:space-between;gap:10px;background:linear-gradient(100deg,#064586,#0755a3);color:#fff}.card-head h2{margin:0;font-size:clamp(18px,3vw,25px);font-weight:800;line-height:1.15}.head-icon{font-size:23px;margin-right:9px}.card-body{padding:12px 16px 14px;background:linear-gradient(120deg,#f8fbff,#eef6ff)}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 24px}.field{min-width:0}.field label{display:flex;align-items:center;gap:8px;margin:0 0 5px;font-weight:700;font-size:16px;color:#111d32}.ico{color:#0878eb;font-size:19px}input,select{width:100%;height:46px;padding:8px 13px;border:2px solid #91a9c5;border-radius:11px;background:#f8fbff;color:#17243a;font-size:18px;outline:none}input:focus,select:focus{border-color:#0875e8;box-shadow:0 0 0 3px #168aff24}input[disabled]{opacity:1;color:#18243b}.full{grid-column:1/-1}.field-wrap{position:relative}.field-wrap input{padding-right:54px}.eye-toggle{position:absolute;right:5px;top:3px;width:42px!important;height:40px;margin:0!important;padding:0!important;background:transparent!important;color:#536985!important;font-size:22px!important}.step-toggle{display:inline-flex;align-items:center;gap:7px;margin:0!important;padding:5px 12px;border-radius:22px;background:#28a514;color:#fff;font-size:15px;font-weight:800;white-space:nowrap}.step-toggle input{appearance:none;-webkit-appearance:none;width:0;height:0;position:absolute;opacity:0}.step-toggle span{min-width:0!important}.step-toggle:has(input:not(:checked)){background:#718096}.enable-badge{display:inline-block;min-width:92px;text-align:center;padding:5px 13px;border-radius:22px;background:#20a515;color:#fff;font-size:15px;font-weight:800}.enable-badge.off{background:#718096}.toggle-row{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));align-items:center;margin:10px 0;padding:8px 10px;border:2px solid #a8c7eb;border-radius:15px;background:#eef6ff}.step-option{display:flex;align-items:center;justify-content:center;gap:10px;min-height:56px;margin:0!important;padding:2px 8px;border-right:1px solid #8ba8c9;font-size:15px;font-weight:700;line-height:1.12}.step-option:last-child{border-right:0}.step-option input{appearance:auto;-webkit-appearance:checkbox;accent-color:#0877ee;width:24px;height:24px;padding:0;margin:0;flex:none}.step-option span{min-width:54px}.appbar .router svg{display:block;width:44px;height:40px}.appbar .menu-home{width:42px!important;padding:4px!important;border:0!important;background:transparent!important;color:#fff;font-size:30px!important;line-height:1}.slid-layout{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(230px,1fr);gap:20px;align-items:center}.sync-box{border-left:2px solid #a6bbd2;padding-left:22px}.sync-box button{width:auto!important;margin:0 0 7px!important;padding:9px 18px!important;border-radius:12px!important;background:#0780ee!important}.sync-note{font-size:14px;color:#637a96;line-height:1.35}.pppoe-card .card-head{background:linear-gradient(100deg,#08498f,#0754a4)}.wifi-grid{display:grid;grid-template-columns:minmax(0,1fr);gap:10px}.wifi-card{border-color:#05804a}.wifi-card .card-head{background:linear-gradient(100deg,#078047,#0a9656)}.wifi-card.band5{border-color:#6332b0}.wifi-card.band5 .card-head{background:linear-gradient(100deg,#562b9f,#7538c5)}.action-card{border:0;background:transparent;box-shadow:none;padding:0}.run{width:100%;height:58px;margin:0!important;border:0;border-radius:13px;background:linear-gradient(90deg,#0873ed,#0661d7);color:#fff;font-size:22px!important;font-weight:800}.status{padding:10px 13px;margin-top:8px;border-radius:10px;background:#e7f2ff;color:#123a66;white-space:pre-wrap;min-height:42px;font-weight:700}.status:empty{display:none}.ok{color:#118943}.err{color:#c22434}.running{color:#bb7800}.log-card{border-color:#a6c7ec;background:#ecf5ff;padding:10px}.log-tools{display:flex;flex-direction:row;justify-content:space-between;align-items:center;gap:10px;margin:0 0 8px}.log-modes,.log-actions{display:flex;align-items:center;gap:12px}.log-mode{display:flex!important;align-items:center;gap:7px;margin:0!important;font-size:16px;white-space:nowrap;color:#14233b}.log-mode input{appearance:none;-webkit-appearance:none;width:22px;height:22px;padding:0;margin:0;border-radius:50%;border:2px solid #9db5d2;background:#fff;flex:none}.log-mode input:checked{border:6px solid #075ff0}.log-actions{margin-left:auto}.log-actions button{width:auto!important;min-width:92px;margin:0!important;padding:8px 12px!important;border:0;border-radius:10px;background:#0874e9;color:white;font-size:16px!important;font-weight:700}.log-actions #clearLogs{background:#d93036}.log{height:320px;min-height:38vh;overflow:auto;margin:0;padding:13px;border-radius:12px;background:#10243a;color:#42e759;font:14px/1.45 Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}button{cursor:pointer}button:disabled{cursor:not-allowed;opacity:.55}@media(max-width:620px){.wrap{padding:0 8px 12px}.appbar{height:64px;margin:0 -8px 9px;padding:0 10px;gap:9px}.appbar .router{font-size:24px}.appbar button.back{width:32px!important;font-size:30px!important}.appbar .menu-home{padding:8px 10px!important;font-size:10px!important}.card{border-radius:15px;margin:9px 0}.card-head{min-height:46px;padding:8px 12px}.card-body{padding:10px}.grid{gap:9px 12px}.field label{font-size:14px}input,select{height:42px;padding:7px 9px;font-size:16px}.step-toggle{padding:5px 9px;font-size:13px}.slid-layout{grid-template-columns:minmax(0,1.2fr) minmax(140px,.8fr);gap:10px}.sync-box{padding-left:10px}.sync-box button{padding:8px 10px!important;font-size:13px!important}.sync-note{font-size:10px}.run{height:52px;font-size:19px!important}.log-tools{gap:7px}.log-modes{gap:8px}.log-mode{font-size:14px}.log-actions{gap:6px}.log-actions button{min-width:68px;padding:8px!important;font-size:14px!important}.log{height:280px;min-height:34vh}}@media(max-width:420px){.toggle-row{grid-template-columns:repeat(4,minmax(0,1fr));padding:5px 3px}.step-option{flex-direction:column;gap:3px;padding:2px 1px;font-size:10px}.step-option span{min-width:0!important;text-align:center;font-size:10px}.wifi-grid,.grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:7px}.full{grid-column:1/-1}.slid-layout{grid-template-columns:minmax(0,1.1fr) minmax(105px,.9fr);gap:8px}.sync-box{border-left:1px solid #a6bbd2;padding:0 0 0 8px;display:block}.sync-note{font-size:10px}.log-tools{flex-wrap:wrap}.log-actions{margin-left:auto}}
@media(max-width:600px){
 .wrap{width:100%;max-width:100%;padding:0 4px 6px}
 .appbar{height:38px;margin:0 -4px 5px;padding:0 7px;gap:6px;box-shadow:none}
 .appbar button.back{width:22px!important;height:28px!important;padding:0!important;border:0!important;border-radius:0!important;outline:0!important;box-shadow:none!important;font-size:24px!important;line-height:1}
 .appbar .router{font-size:0}.appbar .router svg{width:24px;height:22px}
 .appbar strong{font-size:14px!important;white-space:nowrap;line-height:1}
 .appbar .menu-home{width:22px!important;height:28px;padding:0!important;border:0!important;border-radius:0!important;background:transparent!important;font-size:20px!important}
 .card{margin:4px 0;border-width:1px;border-radius:9px;box-shadow:none}
 .card-head{min-height:20px;padding:3px 7px;gap:4px}
 .card-head h2{font-size:10px!important;line-height:1.05;white-space:nowrap;min-width:0;flex:1}
 .head-icon{font-size:10px;margin-right:3px}
 .card-body{padding:5px 7px}
 .grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:5px 8px}
 .field label{font-size:10px;line-height:1.05;gap:4px;margin-bottom:2px}
 .ico{font-size:11px}
 input,select{height:20px;padding:2px 6px;border-width:1px;border-radius:6px;font-size:11px!important;line-height:1.1}
 .full{grid-column:1/-1}
 .field-wrap input{padding-right:27px}
 .eye-toggle{right:2px;top:1px;width:23px!important;height:18px!important;padding:0!important;border:0!important;border-radius:0!important;outline:0!important;box-shadow:none!important;background:transparent!important;font-size:13px!important;line-height:1;color:#536985!important}
 .enable-badge{min-width:48px;padding:2px 6px;font-size:9px;line-height:1.1;flex:none}
 .slid-layout{grid-template-columns:minmax(0,1.15fr) minmax(0,.85fr);gap:7px}
 .sync-box{border-left:1px solid #a6bbd2;padding-left:7px}
 .sync-box button{padding:4px 6px!important;margin:0 0 3px!important;border:0!important;border-radius:6px!important;color:#fff!important;font-size:10px!important;line-height:1.1}
 .sync-note{font-size:8px;line-height:1.15}
 .wifi-grid{grid-template-columns:minmax(0,1fr);gap:8px}
 .wifi-card .card-head{padding:3px 5px;gap:2px}
 .wifi-card .card-head h2{font-size:10px!important;letter-spacing:-.2px}
 .wifi-card .card-body{padding:5px}
 .wifi-card .field label{font-size:9px}
 .wifi-card input{font-size:10px!important;padding:2px 4px}
 .wifi-card .eye-toggle{width:20px!important;height:18px!important}
 .toggle-row{grid-template-columns:repeat(4,minmax(0,1fr));margin:4px 0;padding:3px;border-width:1px;border-radius:8px}
 .step-option{min-height:22px;flex-direction:row!important;justify-content:center;gap:3px;padding:1px 2px;border-right:1px solid #8ba8c9!important;border-bottom:0!important;font-size:8px;line-height:1.05}
 .step-option:nth-child(2){border-right:1px solid #8ba8c9!important}
 .step-option:last-child{border-right:0!important}
 .step-option input{width:13px;height:13px;flex:none}
 .step-option span{min-width:0!important;text-align:left;font-size:8px;line-height:1.05}
 .run{height:22px;padding:2px 6px!important;border-radius:7px;font-size:13px!important;line-height:1}
 .status{min-height:0;padding:4px 6px;margin-top:3px;border-radius:5px;font-size:9px;line-height:1.1}
 .log-card{padding:4px}
 .log-tools{gap:4px;margin-bottom:4px}
 .log-modes,.log-actions{gap:5px}
 .log-mode{gap:3px;font-size:10px!important}
 .log-mode input{width:13px;height:13px;border-width:1px}
 .log-mode input:checked{border-width:4px}
 .log-actions button{min-width:42px;padding:3px 6px!important;border-radius:6px;font-size:10px!important;line-height:1}
 .log{height:260px;min-height:32vh;padding:10px;border-radius:8px;font-size:10px;line-height:1.3}
}
.sync-lookup{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:end}.sync-fetch{width:auto!important;min-width:180px;height:48px;margin:0!important;padding:8px 18px!important;border:0;border-radius:11px!important;background:#0877e8!important;color:#fff!important;font-size:18px!important;font-weight:800}.sync-card .sync-note{margin-top:9px;font-size:16px}.sync-card{border-color:#0877e8}.wifi-grid{grid-template-columns:minmax(0,1fr)!important}.log{height:320px!important;min-height:38vh!important;font-size:16px!important;line-height:1.5!important}@media(max-width:520px){.sync-lookup{grid-template-columns:minmax(0,1fr)}.sync-fetch{width:100%!important}.log{height:280px!important;min-height:34vh!important;font-size:16px!important;line-height:1.5!important}}



/* Separate subscriber lookup, stacked Wi-Fi bands, and taller logs */
.sync-lookup{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:end}
.sync-fetch{width:auto!important;min-width:180px;height:46px;margin:0!important;padding:8px 18px!important;border:0;border-radius:11px!important;background:#0877e8!important;color:#fff!important;font-size:16px!important;font-weight:800}
.sync-card .sync-note{margin-top:9px;font-size:14px;line-height:1.35}
.sync-card{border-color:#0877e8}
.wifi-grid{grid-template-columns:minmax(0,1fr)!important;gap:10px!important}
.log{height:320px!important;min-height:38vh!important}
@media(max-width:520px){.sync-lookup{grid-template-columns:minmax(0,1fr)}.sync-fetch{width:100%!important}.log{height:280px!important;min-height:34vh!important}}
</style></head><body>
<div class="wrap"><header class="appbar"><button class="back" type="button" aria-label="Về trang chủ" onclick="location.href='index.html'">‹</button><span class="router"><svg viewBox="0 0 48 40" aria-hidden="true"><path d="M8 8h32a5 5 0 0 1 5 5v5H3v-5a5 5 0 0 1 5-5Zm-5 14h42v10a5 5 0 0 1-5 5H8a5 5 0 0 1-5-5V22Zm9 7h5m14 0h5" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M15 8V4m18 4V4" stroke="currentColor" stroke-width="3.5" stroke-linecap="round"/></svg></span><strong>CẤU HÌNH MODEM</strong><button class="menu-home" type="button" aria-label="Về trang chủ" onclick="location.href='index.html'">⋮</button></header><section class="card sync-card"><div class="card-head"><h2><span class="head-icon">⇄</span>LẤY THÔNG TIN THUÊ BAO</h2></div><div class="card-body"><div class="sync-lookup"><div class="field"><label for="subscriberAcc">ACC thuê bao</label><input id="subscriberAcc" type="text" placeholder="Nhập ACC thuê bao" autocomplete="off"></div><button type="button" class="sync-fetch" onclick="window.syncSubscriberData(this)">LẤY THÔNG TIN</button></div><div class="sync-note" id="syncStatus">Nhập ACC rồi chọn LẤY THÔNG TIN để điền dữ liệu vào form.</div></div></section><form id="configForm"><section class="card"><div class="card-head"><h2><span class="head-icon">▣</span>1. ĐĂNG NHẬP MODEM</h2></div><div class="card-body"><div class="grid"><div class="field"><label><span class="ico">▣</span>IP Modem</label><input id="ip" value="192.168.1.1" placeholder="192.168.1.1"></div><div class="field"><label><span class="ico">👤</span>Tài khoản</label><input value="admin" disabled></div><div class="field full"><label><span class="ico">⚙</span>Chế độ đăng nhập</label><select id="mode"><option value="1">1 - Modem vừa reset / admin-admin</option><option value="2">2 - Modem đã đổi mật khẩu</option></select></div><div class="field full"><label id="passwordLabel"><span class="ico">🔑</span>Mật khẩu mới (nếu cần)</label><div class="field-wrap"><input id="modemPass" type="text" placeholder="Nhập mật khẩu mới cho modem"></div></div></div></div></section><section class="card"><div class="card-head"><h2><span class="head-icon">♧</span>2. SLID GPON</h2><span class="enable-badge" id="badge-doSlid">Enable</span></div><div class="card-body"><div class="field"><label>SLID GPON</label><input id="slid" value="A00012345"></div></div></section><section class="card pppoe-card"><div class="card-head"><h2><span class="head-icon">◎</span>3. WAN - PPPoE</h2><span class="enable-badge" id="badge-doPppoe">Enable</span></div><div class="card-body"><div class="grid"><div class="field"><label><span class="ico">▣</span>Tài khoản PPPoE</label><input id="pppoeUser" value="ppp_user"></div><div class="field"><label><span class="ico">♧</span>VLAN WAN</label><input id="vlan" value="11" disabled></div><div class="field full"><label><span class="ico">🔑</span>Mật khẩu PPPoE</label><div class="field-wrap"><input id="pppoePass" type="text" value="abcd1234"></div></div></div></div></section><div class="wifi-grid"><section class="card wifi-card band24"><div class="card-head"><h2><span class="head-icon">◉</span>4. WiFi 2.4 GHz</h2><span class="enable-badge" id="badge-doWifi2g">Enable</span></div><div class="card-body"><div class="field"><label><span class="ico">◉</span>Tên WiFi (SSID)</label><input id="wifi2g" type="text" value="WiFi 2.4G"></div><div class="field" style="margin-top:9px"><label><span class="ico">🔑</span>Mật khẩu WiFi</label><div class="field-wrap"><input id="pass2g" type="text" value="1234567890"></div></div></div></section><section class="card wifi-card band5"><div class="card-head"><h2><span class="head-icon">◉</span>5. WiFi 5 GHz</h2><span class="enable-badge" id="badge-doWifi5g">Enable</span></div><div class="card-body"><div class="field"><label><span class="ico">◉</span>Tên WiFi (SSID)</label><input id="wifi5g" type="text" value="WiFi 5G"></div><div class="field" style="margin-top:9px"><label><span class="ico">🔑</span>Mật khẩu WiFi</label><div class="field-wrap"><input id="pass5g" type="text" value="1234567890"></div></div></div></section></div><section class="toggle-row"><label class="step-option"><input id="doSlid" type="checkbox" checked onchange="syncStepBadges()"><span>SLID<br>GPON</span></label><label class="step-option"><input id="doPppoe" type="checkbox" checked onchange="syncStepBadges()"><span>WAN<br>PPPoE</span></label><label class="step-option"><input id="doWifi2g" type="checkbox" checked onchange="syncStepBadges()"><span>WiFi<br>2.4 GHz</span></label><label class="step-option"><input id="doWifi5g" type="checkbox" checked onchange="syncStepBadges()"><span>WiFi<br>5 GHz</span></label></section><section class="action-card"><button class="run" type="button" id="run">▶ &nbsp;BẮT ĐẦU CẤU HÌNH</button><div id="status" class="status">Sẵn sàng.</div></section></form><section class="card log-card"><div class="log-tools" id="logControls"><div class="log-modes"><label class="log-mode"><input type="radio" name="logMode" value="quick" checked> Log</label><label class="log-mode"><input type="radio" name="logMode" value="raw"> Log RAW</label></div><div class="log-actions"><button type="button" id="copyLogs">Copy</button><button type="button" id="clearLogs">Del</button></div></div><pre id="logs" class="log">Chưa có log.</pre></section></div><script>function syncStepBadges(){['doSlid','doPppoe','doWifi2g','doWifi5g'].forEach(function(id){var c=document.getElementById(id),b=document.getElementById('badge-'+id);if(c&&b){b.textContent=c.checked?'Enable':'Disable';b.classList.toggle('off',!c.checked)}})}function toggleField(id,b){var e=document.getElementById(id);if(!e)return;e.type=e.type==='password'?'text':'password';b.textContent=e.type==='password'?'◉':'◎';}syncStepBadges();</script>
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
  #status{display:none!important}


/* Separate subscriber lookup, stacked Wi-Fi bands, and taller logs */
.sync-lookup{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:end}
.sync-fetch{width:auto!important;min-width:180px;height:46px;margin:0!important;padding:8px 18px!important;border:0;border-radius:11px!important;background:#0877e8!important;color:#fff!important;font-size:16px!important;font-weight:800}
.sync-card .sync-note{margin-top:9px;font-size:14px;line-height:1.35}
.sync-card{border-color:#0877e8}
.wifi-grid{grid-template-columns:minmax(0,1fr)!important;gap:10px!important}
.log{height:320px!important;min-height:38vh!important}
@media(max-width:520px){.sync-lookup{grid-template-columns:minmax(0,1fr)}.sync-fetch{width:100%!important}.log{height:280px!important;min-height:34vh!important}}
</style></head><body><main><section class="card"><h2>📋 CẤU HÌNH MODEM NS V2</h2><div class="muted">Nhật ký cập nhật tự động. Không đóng trang trong khi modem đang cấu hình.</div><div id="status" class="status">Đang kết nối...</div><div class="log-tools" id="logControls"><div class="log-modes"><label class="log-mode"><input type="radio" name="logMode" value="quick" checked> Log</label><label class="log-mode"><input type="radio" name="logMode" value="raw"> Log RAW</label></div><div class="log-actions"><button type="button" id="copyLogs">Copy</button><button type="button" id="clearLogs">Del</button></div></div><pre id="logs">Đang chờ nhật ký...</pre></section></main>
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
    if(req.method==="POST" && u.pathname==="/api/client-log"){const data=JSON.parse(await readBody(req)||"{}");const stamp=`[${new Date().toLocaleTimeString("vi-VN",{hour12:false})}]\n`;if(data.quick)logs.push(stamp+String(data.quick));if(data.raw)rawLogs.push(stamp+String(data.raw));logs=logs.slice(-MAX_LOGS);rawLogs=rawLogs.slice(-MAX_LOGS);return json(res,{ok:true});}
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

