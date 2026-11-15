// 6_modem_api(7).js
// Chuyển từ Python sang Node.js, giữ nguyên API/payload/flow.
// Không dùng CORS của trình duyệt. Chạy: node 6_modem_api(7).js

"use strict";

const https = require("https");
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
const net = require("net");

let MODEM_IP = "";
let USERNAME = "admin";
let PASSWORD = "";
let PASSWORD_NEW = "";
let slid_gpon = "";
let user_pppoe = "";
let pass_pppoe = "";
let vlan_id = "11";
let name_wifi_2g = "";
let pass_wifi_2g = "";
let name_wifi_5g = "";
let pass_wifi_5g = "";

// Giống urllib.parse.quote(..., safe="")
function quote(v) {
  return encodeURIComponent(String(v));
}

function encodePayload(payload) {
  return Object.entries(payload).map(([k,v]) => `${quote(k)}=${quote(v)}`).join("&");
}

// CRC32 tương đương zlib.crc32(...). 
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(str) {
  const b = Buffer.from(str, "utf8");
  let c = 0xFFFFFFFF;
  for (const x of b) c = (crcTable[(c ^ x) & 0xFF] ^ (c >>> 8)) >>> 0;
  return ((c ^ 0xFFFFFFFF) >>> 0).toString(16).padStart(8, "0");
}

function httpsRequest(method, urlString, headers={}, body="") {
  return new Promise((resolve, reject) => {
    const u = new URL(urlString);
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method,
      rejectUnauthorized: false,
      headers: { ...headers, ...(body ? {"Content-Length": Buffer.byteLength(body)} : {}) },
      timeout: 30000
    }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({
        status: res.statusCode,
        headers: res.headers,
        text: Buffer.concat(chunks).toString("utf8")
      }));
    });
    req.on("timeout", () => req.destroy(new Error("TIMEOUT")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function runRequest(method, url, headers={}, body="") {
  const r = await httpsRequest(method, url, headers, body);
  return r.text;
}

// ===================== LOGIN =====================
async function login_and_get_etoken(username, password) {
  const encoded_password = quote(password);
  const post_data =
    `CsrfToken=&username=${quote(username)}` +
    `&password=${encoded_password}&Language_Flag=0`;

  stepLog("1/4 Login: POST check_auth.json để xác thực và lấy token");
  console.log("📤 Gửi yêu cầu đăng nhập modem");

  const stdout = await runRequest("POST",
    `https://${MODEM_IP}/cgi-bin/check_auth.json`,
    {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      "Cookie": "loginTimes=0",
      "Origin": `https://${MODEM_IP}`
    }, post_data);

  console.log("📥 Đã nhận phản hồi đăng nhập modem");
  try {
    const data = JSON.parse(stdout);
    const privilege = data.Privilege;
    const ecnt_token = data.ecntToken;
    console.log(`Privilege = ${privilege}`);
    if (["1","2","3",1,2,3].includes(privilege)) {
      console.log("✅ ĐĂNG NHẬP OK");
      return ecnt_token;
    }
    console.log("❌ ĐĂNG NHẬP FAIL");
    return null;
  } catch (e) {
    console.log(`❌ Lỗi: ${e.message}`);
    return null;
  }
}

// ===================== CSRF =====================
async function get_csrf_token_from_page(ecnt_token, page_url) {
  console.log(`\n📡 Lấy token từ ${page_url}...`);
  const stdout = await runRequest("GET", page_url, {
    "Cookie": `ecntToken=${ecnt_token}`,
    "Referer": page_url,
    "Origin": `https://${MODEM_IP}`
  });
  const token = extractCsrfToken(stdout);
  if (token) {
    console.log("✅ Đã lấy CSRF token");
    return token;
  }
  console.log("❌ Không tìm thấy token");
  return null;
}

function extractCsrfToken(html) {
  const source = String(html || "");
  // Router firmware varies the order and quoting of input attributes.
  for (const tag of source.match(/<input\b[^>]*>/gi) || []) {
    const attrs = {};
    const attrPattern = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
    let attr;
    while ((attr = attrPattern.exec(tag))) {
      attrs[attr[1].toLowerCase()] = attr[2] ?? attr[3] ?? attr[4] ?? "";
    }
    if ((attrs.name || "").toLowerCase() === "csrftoken" && attrs.value) return attrs.value;
  }

  const patterns = [
    /csrf_token\s*=\s*["']([^"']+)["']/i,
    /\bCsrfToken\s*=\s*["']([^"']+)["']/i
  ];
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function extractInputValue(html, inputName) {
  const expected = String(inputName || "").toLowerCase();
  for (const tag of String(html || "").match(/<input\b[^>]*>/gi) || []) {
    const attrs = {};
    const attrPattern = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
    let attr;
    while ((attr = attrPattern.exec(tag))) {
      attrs[attr[1].toLowerCase()] = attr[2] ?? attr[3] ?? attr[4] ?? "";
    }
    if ((attrs.name || "").toLowerCase() === expected) return attrs.value ?? "";
  }
  return null;
}

function ebooAndBody(payload) {
  const body = encodePayload(payload);
  let crcSource = "";
  for (const [key,value] of Object.entries(payload)) crcSource += key + String(value);
  return { body, eboovalue: crc32(crcSource) };
}

async function postModemForm(path, payload, ecnt_token, extraHeaders={}) {
  const {body, eboovalue} = ebooAndBody(payload);
  const response = await httpsRequest("POST", `https://${MODEM_IP}${path}`, {
    "Content-Type": "application/x-www-form-urlencoded",
    "Cookie": `EBOOVALUE=${eboovalue}; ecntToken=${ecnt_token}`,
    "Referer": `https://${MODEM_IP}${path}`,
    "Origin": `https://${MODEM_IP}`,
    ...extraHeaders
  }, body);
  const wrappedStatus = String(response.text || "").match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})\b/i);
  const modemStatus = wrappedStatus ? Number(wrappedStatus[1]) : response.status;
  if (modemStatus >= 400) throw new Error(`POST ${path} trả HTTP ${modemStatus}`);
  console.log(`📥 POST ${path}: modem trả HTTP ${modemStatus}`);
  return response.text;
}

// ===================== WIFI 5G =====================
async function config_wifi_5g(ecnt_token, new_ssid="WiFi 5G", new_password="1234567890", csrf_token=null) {
  if (!csrf_token) csrf_token = await get_csrf_token_from_page(ecnt_token, `https://${MODEM_IP}/cgi-bin/net-wlan11ac.asp`);
  if (!csrf_token) throw new Error("Lỗi lấy token Wi-Fi 5G");

const payload = {};
payload["wlanWEPFlag"] = "3";
payload["CountryChange"] = "0";
payload["WDS_EncrypType_NONE"] = "NONE";
payload["WDS_EncrypType_WEP"] = "WEP";
payload["BasicRate_Value1"] = "15";
payload["BasicRate_Value2"] = "3";
payload["BasicRate_Value3"] = "351";
payload["CountryRegionABand0"] = "0";
payload["CountryRegionABand1"] = "1";
payload["CountryRegionABand2"] = "2";
payload["CountryRegionABand3"] = "3";
payload["CountryRegionABand4"] = "4";
payload["CountryRegionABand5"] = "5";
payload["CountryRegionABand6"] = "6";
payload["CountryRegionABand7"] = "7";
payload["CountryRegionABand8"] = "8";
payload["CountryRegionABand9"] = "9";
payload["CountryRegionABand10"] = "10";
payload["CountryRegionABand11"] = "11";
payload["CountryRegionABand13"] = "13";
payload["HTMCSAUTO"] = "33";
payload["HTBW"] = "0";
payload["VHTBW"] = "0";
payload["RTDEVICE"] = "7916";
payload["Is11nMode"] = "1";
payload["Is11acMode"] = "1";
payload["CountryName"] = "UNITED STATES";
payload["ExtChannFlag"] = "0";
payload["BssidNum"] = "4";
payload["hCountryRegionABand"] = "7";
payload["WPSConfigured"] = "2";
payload["WpsConfModeAll"] = "7";
payload["WpsConfModeNone"] = "0";
payload["WpsStart"] = "0";
payload["isInWPSing"] = "0";
payload["maxStaNum"] = "32";
payload["isAuthenTypeSupported"] = "0";
payload["isDot1XSupported"] = "0";
payload["isDot1XEnhanceSupported"] = "0";
payload["isWDSSupported"] = "1";
payload["bharti_ssid2"] = "0";
payload["wlan_VC"] = "0";
payload["isWPSSupported"] = "1";
payload["isPerSSIDSupport"] = "1";
payload["WscV2Support"] = "0";
payload["is11AXModeSupported"] = "1";
payload["isWPA3ModeSupported"] = "1";
payload["hRekeyMethod"] = "TIME";
payload["Wlan11acMuOfdmaDlEnable_flag"] = "1";
payload["Wlan11acMuOfdmaUlEnable_flag"] = "1";
payload["Wlan11acMuMimoDlEnable_flag"] = "1";
payload["Wlan11acMuMimoUlEnable_flag"] = "1";
payload["SSID_INDEX"] = "0";
payload["wlEnable"] = "on";
payload["ESSID_Enable_Selection"] = "1";
payload["ESSID"] = new_ssid;
payload["ESSID_HIDE_Selection"] = "0";
payload["WEP_Selection"] = "WPAPSKWPA2PSK";
payload["WEP_Selection_val"] = "WPAPSKWPA2PSK";
payload["WEP_TypeSelection1"] = "OpenSystem";
payload["wlKeyBit"] = "64";
payload["wlKeyIndex"] = "1";
payload["WEP_Key13"] = "";
payload["WEP_Key23"] = "";
payload["WEP_Key33"] = "";
payload["WEP_Key43"] = "";
payload["PreSharedKey1"] = new_password;
payload["TKIP_Selection4"] = "AES";
payload["keyRenewalInterval1"] = "3600";
payload["PreSharedKey2"] = new_password;
payload["TKIP_Selection5"] = "AES";
payload["keyRenewalInterval2"] = "3600";
payload["PreSharedKey3"] = new_password;
payload["TKIP_Selection6"] = "AES";
payload["keyRenewalInterval3"] = "3600";
payload["PreSharedKey_WPA2WPA3"] = new_password;
payload["TKIP_Selection_WPA2WPA3"] = "AES";
payload["keyRenewalInterval_WPA2WPA3"] = "3600";
payload["PreSharedKey_WPA3"] = new_password;
payload["TKIP_Selection_WPA3"] = "AES";
payload["keyRenewalInterval_WPA3"] = "3600";
payload["apEnable"] = "on";
payload["wlan_APenable"] = "1";
payload["Countries_Channels"] = "UNITED STATES";
payload["Channel_ID"] = "0";
payload["wlTxPwr"] = "6";
payload["StationNum"] = "32";
payload["BeaconInterval"] = "100";
payload["RTSThreshold"] = "2347";
payload["FragmentThreshold"] = "2346";
payload["DTIM"] = "1";
payload["WirelessMode"] = "17";
payload["WLANChannelBandwidth"] = "1";
payload["WLANGuardInterval"] = "1";
payload["WLan11acVHTChannelBandwidth"] = "1";
payload["WLan11acVHTGuardInterval"] = "1";
payload["UseWPS_Selection"] = "";
payload["WPSMode_Selection"] = "1";
payload["WLAN_WDS_Active"] = "0";
payload["WLAN_FltActive"] = "0";
payload["TWTSupport_flag"] = "1";
payload["Wlan11acMuOfdmaDlEnable"] = "on";
payload["Wlan11acMuOfdmaUlEnable"] = "on";
payload["Wlan11acMuMimoDlEnable"] = "on";
payload["Wlan11acMuMimoUlEnable"] = "on";
payload["CsrfToken"] = csrf_token;
  console.log(`\n📤 Cấu hình Wi-Fi 5G: ${new_ssid}`);
  const stdout = await postModemForm("/cgi-bin/net-wlan11ac.asp", payload, ecnt_token);
  if (stdout.includes(new_ssid) && stdout.includes(new_password)) console.log("\n✅ WIFI 5G THÀNH CÔNG!");
  else { console.log("\n❌ WIFI 5G THẤT BẠI!"); throw new Error("Modem không xác nhận cấu hình Wi-Fi 5G"); }
  return stdout;
}

// ===================== WIFI 2.4G =====================
async function config_wifi_2g(ecnt_token, new_ssid="WiFi 2.4G", new_password="1234567890", csrf_token=null) {
  if (!csrf_token) csrf_token = await get_csrf_token_from_page(ecnt_token, `https://${MODEM_IP}/cgi-bin/net-wlan.asp`);
  if (!csrf_token) throw new Error("Lỗi lấy token Wi-Fi 2.4G");

const payload = {};
payload["hCountryRegion"] = "0";
payload["CountryName"] = "UNITED STATES";
payload["CountryChange"] = "0";
payload["CountryRegion0"] = "0";
payload["CountryRegion1"] = "1";
payload["CountryRegion2"] = "2";
payload["CountryRegion3"] = "3";
payload["CountryRegion4"] = "4";
payload["CountryRegion5"] = "5";
payload["is11AXModeSupported"] = "1";
payload["isWPA3ModeSupported"] = "1";
payload["hwlKeys0"] = "";
payload["hwlKeys1"] = "";
payload["hwlKeys2"] = "";
payload["hwlKeys3"] = "";
payload["hwlgMode"] = "16";
payload["hwlAuthMode"] = "WPAPSKWPA2PSK";
payload["hwlEnbl"] = "1";
payload["hWPSMode"] = "1";
payload["henableSsid"] = "1";
payload["hwlHide"] = "0";
payload["isInWPSing"] = "0";
payload["WpsConfModeAll"] = "7";
payload["WpsConfModeNone"] = "0";
payload["hWpsStart"] = "0";
payload["WpsGenerate"] = "0";
payload["isCUCSupport"] = "0";
payload["SSIDPre"] = "N/A";
payload["isDot1XSupported"] = "0";
payload["isDot1XEnhanceSupported"] = "0";
payload["isWDSSupported"] = "1";
payload["WDS_EncrypType_NONE"] = "NONE";
payload["WDS_EncrypType_WEP"] = "WEP";
payload["SSID_Flag"] = "0";
payload["WpsActive"] = "0";
payload["WlanMuOfdmaDlEnable_flag"] = "1";
payload["WlanMuOfdmaUlEnable_flag"] = "1";
payload["WlanMuMimoDlEnable_flag"] = "1";
payload["WlanMuMimoUlEnable_flag"] = "1";
payload["WlanBandSteering_flag"] = "0";
payload["WlanAirTimeFairNess_flag"] = "0";
payload["Save_Flag"] = "1";
payload["wlSsidIdx"] = "0";
payload["enableSsid"] = "on";
payload["wlSsid"] = new_ssid;
payload["wlSecurMode"] = "WPAand11i";
payload["wlPreauth"] = "off";
payload["wlNetReauth"] = "1";
payload["wlWpaPsk"] = new_password;
payload["wlWpaGtkRekey"] = "";
payload["WPARekeyInter"] = "3600";
payload["wlWpa"] = "AES";
payload["wlKeyBit"] = "64";
payload["wlKeys"] = "";
payload["radiusSVR_IP"] = "";
payload["radiusSVR_Port"] = "";
payload["radiusSVR_Key"] = "";
payload["radiusSVR_ReAuthInter"] = "";
payload["wlEnbl"] = "ON";
payload["Countries_Channels"] = "UNITED STATES";
payload["wlChannel"] = "0";
payload["wlTxPwr"] = "6";
payload["wlAssociateNum"] = "32";
payload["BeaconInterval"] = "100";
payload["RTSThreshold"] = "2347";
payload["FragmentThreshold"] = "2346";
payload["wlgMode"] = "g,n,ax";
payload["bwControl"] = "2";
payload["giControl"] = "1";
payload["wpsmode"] = "ap-pbc";
payload["WLAN_WDS_Active"] = "0";
payload["WLAN_FltActive"] = "0";
payload["TWTSupport"] = "1";
payload["wlanMuOfdmaDlEnable"] = "on";
payload["wlanMuOfdmaUlEnable"] = "on";
payload["wlanMuMimoDlEnable"] = "on";
payload["wlanMuMimoUlEnable"] = "on";
payload["CsrfToken"] = csrf_token;
  console.log(`\n📤 Cấu hình Wi-Fi 2.4G: ${new_ssid}`);
  const stdout = await postModemForm("/cgi-bin/net-wlan.asp", payload, ecnt_token);
  console.log("\n📥 Đã nhận phản hồi HTTP cho lệnh Wi-Fi 2.4G; không tải lại trang để xác minh.");
  return stdout;
}

// ===================== SLID =====================
async function set_slid(ecnt_token, new_slid="A00012345") {
  const csrf_token = await get_csrf_token_from_page(ecnt_token, `https://${MODEM_IP}/cgi-bin/mag-gponpassword.asp`);
  if (!csrf_token) throw new Error("Lỗi lấy token SLID");

const payload = {};
payload["Password_set"] = String(new_slid);
payload["Saveflag"] = "1";
payload["inpPassword"] = "Password";
payload["CsrfToken"] = csrf_token;
  console.log(`\n📤 SLID: ${new_slid}`);
  const stdout = await postModemForm("/cgi-bin/mag-gponpassword.asp", payload, ecnt_token);
  if (stdout.includes(new_slid)) console.log("\n✅ SLID THÀNH CÔNG!");
  else { console.log("\n❌ SLID THẤT BẠI!"); throw new Error("Modem không xác nhận cấu hình SLID"); }
  return stdout;
}

// ===================== DELETE PPPoE =====================
// ===================== WAN HELPERS =====================
function readWanArray(html, reText) {
  const m = html.match(new RegExp(reText, 'i'));
  return m ? m[1].split(',').filter(x => x !== '') : [];
}

function readWanListFromHtml(html) {
  const n = readWanArray(html, "var\\s+vArrayStr\\s*=\\s*[\"']([^\"']*)[\"'];\\s*var\\s+vEntryName");
  const idx = readWanArray(html, "vArrayStr\\s*=\\s*[\"']([^\"']*)[\"'];\\s*var\\s+vEntryIndex");
  const enc = readWanArray(html, "vArrayStr\\s*=\\s*[\"']([^\"']*)[\"'];\\s*var\\s+Wan_ENCAP");
  const vp = readWanArray(html, "vArrayStr\\s*=\\s*[\"']([^\"']*)[\"'];\\s*var\\s+Wan_VidPRI");
  const ifidx = readWanArray(html, "var\\s+CycleV\\s*=\\s*[\"']([^\"']*)[\"'];\\s*var\\s+IFIdxArray");
  const cm = html.match(/var\s+nEntryNum\s*=\s*["'](\d+)["']/i);
  const count = cm ? parseInt(cm[1],10) : Math.max(n.length,idx.length);
  const list=[];
  for(let i=0;i<count;i++) {
    const vpv=vp[i]||'';
    const parts=vpv.split('/');
    list.push({pos:i,name:n[i]||'',domain:idx[i]||'',wanId:idx[i]||'',encap:enc[i]||'',vlan:parts[0]||'',priority:parts[1]||'',ifaceIndex:ifidx[i]||''});
  }
  return list;
}

async function get_wan_list(ecnt_token) {
  const page=`https://${MODEM_IP}/cgi-bin/net-wanset.asp`;
  const html=await runRequest('GET',page,{'Cookie':`ecntToken=${ecnt_token}`,'Referer':page,'Origin':`https://${MODEM_IP}`,'User-Agent':'Mozilla/5.0'});
  if (!/var\s+nEntryNum\s*=/.test(html) || !/var\s+vEntryName\s*=/.test(html)) {
    throw new Error('Không đọc được danh sách WAN từ modem; dừng để tránh tạo PPPoE trùng.');
  }
  const list=readWanListFromHtml(html);
  console.log(`📡 WAN hiện tại: ${list.length}`);
  for(const w of list) console.log(`   [${w.pos}] ${w.name} | ${w.encap} | VLAN ${w.vlan}/${w.priority} | domain=${w.domain} | IFIdx=${w.ifaceIndex}`);
  return {html,list,csrf:extractCsrfToken(html)};
}

function buildWanPayload(csrf_token,vlan_id) {
  const p={};
  p.WanActive='Yes'; p.EnCAPFlag='PPPoE LLC'; p.PPPGetIpFlag='Dynamic'; p.ConnectionFlag='Connect_Keep_Alive';
  p.Enable_Flag='Yes'; p.Disable_Flag='No'; p.dhcpv6pdflag='Yes'; p.pppManualStatus_Flag='disconnect'; p.cb_enblService='on'; p.enblService='';
  p.wanMode='Route'; p.serviceList='INTERNET'; p.bindflag='N/A'; p.cb_enabledhcp='on'; p.enable_dhcp='1'; p.linkMode='linkPPP';
  p.IpVersion='IPv4/IPv6'; p.IPVersionValue='IPv4/IPv6'; p.ISPTypeValue='2'; p.IpMode='PPPoE'; p.bridgeMode='IP_Bridged';
  p.dhcprelay='No'; p.multMode='0'; p.VLANMode='TAG'; p.vlan=String(vlan_id); p.vlanId='Yes'; p.vlanUNTAG='4096'; p.vlanTRANSPARENT='4097';
  p.v8021P='1'; p.vlanPri='Yes'; p.vlanPriNone='0'; p.MulticastVID=''; p.MulVIDUsed='Yes'; p.MTU='1492'; p.cb_nat='on'; p.nat='Enable'; p.enblIgmp='No';
  p.wanIpAddress=''; p.wanSubnetMask=''; p.defaultGateway=''; p.dnsPrimary=''; p.dnsSecondary=''; p.pppServerName=''; p.pppTimeOut=''; p.pppv6Mode='No';
  p.enablepppbi=''; p.pppbiUsed='No'; p.pppbiDisabled='No'; p.IdIpv6AddrType='SLAAC'; p.IdIpv6Addr=''; p.IdIpv6PrefixLen=''; p.IdIpv6Gateway=''; p.IdIpv6Dns1=''; p.IdIpv6Dns2='';
  p.cb_enabledpd='on'; p.enablepd='Yes'; p.PDUsed='Yes'; p.PDDisabled='No'; p.pdmode='Yes'; p.pdmodeUsed='Yes'; p.pdmodeDisabled='No'; p.pdmodeAuto='PrefixDelegation'; p.pdmodeStatic='Static'; p.pdmodeNone='None';
  p.pdprefix=''; p.pdprefixptime=''; p.pdprefixvtime=''; p.enabledslite=''; p.dsliteUsed='No'; p.dsliteDisabled='No'; p.dslitemode='0'; p.dsliteaddress=''; p.pppIdleTimeout='0'; p.xponstate='Yes'; p.CsrfToken=csrf_token;
  for(let i=1;i<=8;i++){p[`bindlan${i}`]='No';p[`bindwireless${i}`]='No';p[`bindwirelessac${i}`]='No';}
  for(let i=1;i<=4;i++){p[`Option60Enable${i}`]='';p[`Option60Type${i}`]='';p[`Option60ValueMode${i}`]='';p[`Option60Value${i}`]='';}
  return p;
}

// ===================== NEW PPPoE =====================
async function wan_new_pppoe(ecnt_token,user_ppp,pass_ppp,vlan_id='11') {
  const current=await get_wan_list(ecnt_token);
  if(!current.csrf) throw new Error('Không lấy được CSRF token để tạo PPPoE.');
  const existing=current.list.find(w=>String(w.vlan)===String(vlan_id)&&/ppp/i.test(w.encap));
  if(existing){
    console.log(`ℹ️ PPPoE VLAN ${vlan_id} đã tồn tại (${existing.name}); giữ nguyên, bỏ qua tạo mới.`);
    return false;
  }
  const used=current.list.map(w=>parseInt(w.ifaceIndex,10)).filter(Number.isFinite);
  const storeMatch=current.html.match(/var\s+IFIdxStore\s*=\s*["'](\d+)["']/i);
  const firstCandidate=storeMatch?parseInt(storeMatch[1],10)+1:3;
  let next=firstCandidate;
  while(used.includes(next)&&next<=99) next++;
  if(next>99) throw new Error('Không tìm thấy IFIdx còn trống để tạo PPPoE.');
  const p=buildWanPayload(current.csrf,vlan_id);
  p.curSetIndex='0'; p.WanCurrIFIdx=String(next); p.wanId='-1'; p.Wan_Flag='1'; p.afterdeleteFlag='0'; p.OperatorStyle='Add';
  p.pppUserName=user_ppp; p.pppPassword=pass_ppp;
  stepLog("3/4 PPPoE: POST tạo kết nối mới");
  console.log(`\n📤 TẠO PPPoE | VLAN ${vlan_id} | IFIdx=${next}`);
  const out=await postModemForm('/cgi-bin/net-wanset.asp',p,ecnt_token,{'User-Agent':'Mozilla/5.0','Accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8','Accept-Language':'vi,en-US;q=0.9,en;q=0.8'});
  console.log(`📥 Modem đã phản hồi lệnh tạo PPPoE VLAN ${vlan_id}; không tải lại danh sách WAN.`);
  return out;
}

// ===================== EDIT PPPoE =====================
async function wan_edit_pppoe(ecnt_token, user_ppp, pass_ppp, vlan_id="11") {
  const csrf_token = await get_csrf_token_from_page(ecnt_token, `https://${MODEM_IP}/cgi-bin/net-wanset.asp`);
  if (!csrf_token) { console.log("❌ Lỗi lấy token PPPoE"); return null; }

const payload = {};
payload["curSetIndex"] = "8";
payload["WanActive"] = "Yes";
payload["WanCurrIFIdx"] = "2";
payload["wanId"] = "8";
payload["Wan_Flag"] = "1";
payload["EnCAPFlag"] = "PPPoE LLC";
payload["PPPGetIpFlag"] = "Dynamic";
payload["ConnectionFlag"] = "Connect_Keep_Alive";
payload["Enable_Flag"] = "Yes";
payload["Disable_Flag"] = "No";
payload["afterdeleteFlag"] = "0";
payload["OperatorStyle"] = "Modify";
payload["dhcpv6pdflag"] = "Yes";
payload["pppManualStatus_Flag"] = "disconnect";
payload["cb_enblService"] = "on";
payload["enblService"] = "";
payload["wanMode"] = "Route";
payload["serviceList"] = "INTERNET";
payload["bindflag"] = "N/A";
payload["cb_enabledhcp"] = "on";
payload["enable_dhcp"] = "1";
payload["linkMode"] = "linkPPP";
payload["IpVersion"] = "IPv4/IPv6";
payload["IPVersionValue"] = "IPv4/IPv6";
payload["ISPTypeValue"] = "2";
payload["IpMode"] = "PPPoE";
payload["bridgeMode"] = "PPPoE_Bridged";
payload["dhcprelay"] = "No";
payload["multMode"] = "0";
payload["VLANMode"] = "TAG";
payload["vlan"] = vlan_id;
payload["vlanId"] = "Yes";
payload["vlanUNTAG"] = "4096";
payload["vlanTRANSPARENT"] = "4097";
payload["v8021P"] = "0";
payload["vlanPri"] = "Yes";
payload["vlanPriNone"] = "0";
payload["MulticastVID"] = "";
payload["MulVIDUsed"] = "Yes";
payload["MTU"] = "1492";
payload["cb_nat"] = "on";
payload["nat"] = "Enable";
payload["enblIgmp"] = "No";
payload["wanIpAddress"] = "";
payload["wanSubnetMask"] = "";
payload["defaultGateway"] = "";
payload["dnsPrimary"] = "";
payload["dnsSecondary"] = "";
payload["pppUserName"] = user_ppp;
payload["pppPassword"] = pass_ppp;
payload["pppServerName"] = "";
payload["pppTimeOut"] = "";
payload["pppv6Mode"] = "No";
payload["enablepppbi"] = "";
payload["pppbiUsed"] = "No";
payload["pppbiDisabled"] = "No";
payload["IdIpv6AddrType"] = "SLAAC";
payload["IdIpv6Addr"] = "";
payload["IdIpv6PrefixLen"] = "";
payload["IdIpv6Gateway"] = "";
payload["IdIpv6Dns1"] = "";
payload["IdIpv6Dns2"] = "";
payload["cb_enabledpd"] = "on";
payload["enablepd"] = "Yes";
payload["PDUsed"] = "Yes";
payload["PDDisabled"] = "No";
payload["pdmode"] = "Yes";
payload["pdmodeUsed"] = "Yes";
payload["pdmodeDisabled"] = "No";
payload["pdmodeAuto"] = "PrefixDelegation";
payload["pdmodeStatic"] = "Static";
payload["pdmodeNone"] = "None";
payload["pdprefix"] = "";
payload["pdprefixptime"] = "";
payload["pdprefixvtime"] = "";
payload["enabledslite"] = "";
payload["dsliteUsed"] = "No";
payload["dsliteDisabled"] = "No";
payload["dslitemode"] = "0";
payload["dsliteaddress"] = "";
payload["pppIdleTimeout"] = "0";
payload["xponstate"] = "Yes";
payload["CsrfToken"] = csrf_token;
for (let i = 1; i <= 8; i++) payload[`bindlan${i}`] = "No";
for (let i = 1; i <= 8; i++) payload[`bindwireless${i}`] = "No";
for (let i = 1; i <= 8; i++) payload[`bindwirelessac${i}`] = "No";
for (let i = 1; i <= 4; i++) {
  payload[`Option60Enable${i}`] = "";
  payload[`Option60Type${i}`] = "";
  payload[`Option60ValueMode${i}`] = "";
  payload[`Option60Value${i}`] = "";
}
  console.log(`\n📤 Cấu hình PPPoE | VLAN ${vlan_id}`);
  const stdout = await postModemForm("/cgi-bin/net-wanset.asp", payload, ecnt_token, {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "vi,en-US;q=0.9,en;q=0.8"
  });
  if (stdout.includes(user_ppp) && stdout.includes(pass_ppp)) console.log("\n✅ PPPoE THÀNH CÔNG!");
  else console.log("\n❌ PPPoE THẤT BẠI!");
  return stdout;
}

// ===================== CHANGE FIRST PASSWORD =====================
async function change_first_pass(ecnt_token, new_password, confirm_password) {
  const csrf_token = await get_csrf_token_from_page(ecnt_token, `https://${MODEM_IP}/cgi-bin/changeFirstPass.asp`);
  if (!csrf_token) { console.log("❌ Lỗi lấy token đổi password"); return null; }

const payload = {};
payload["submitFlag"] = "1";
payload["newpass"] = new_password;
payload["confirmnew"] = confirm_password;
payload["CsrfToken"] = csrf_token;
  console.log("\n📤 Gửi yêu cầu đổi mật khẩu quản trị");
  const stdout = await postModemForm("/cgi-bin/changeFirstPass.asp", payload, ecnt_token, {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "vi,en-US;q=0.9,en;q=0.8"
  });
  console.log("\n" + "-".repeat(40));
  if (stdout.includes("Your password has been changed successfully")) console.log("✅ ĐỔI PASS THÀNH CÔNG!");
  else if (stdout.includes("400 Bad Request")) console.log("❌ ĐỔI PASS THẤT BẠI!");
  else console.log("⚠️ ĐỔI PASS HOÀN TẤT! Kiểm tra lại.");
  return stdout;
}


// ===================== HTTP WEB SERVER =====================
const http = require("http");
const fs = require("fs");

function parseAppArgs(argv) {
  const out = {
    port: Number(process.env.PORT || 3000),
    host: process.env.HOST || "127.0.0.1",
    token: "",
    cwd: ""
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port" && argv[i + 1]) {
      out.port = Number(argv[++i]);
    } else if (a === "--host" && argv[i + 1]) {
      out.host = argv[++i];
    } else if (a === "--token" && argv[i + 1]) {
      out.token = argv[++i];
    } else if (a === "--cwd" && argv[i + 1]) {
      out.cwd = argv[++i];
    }
  }

  if (!Number.isInteger(out.port) || out.port < 1 || out.port > 65535) {
    throw new Error("Port không hợp lệ: " + out.port);
  }
  return out;
}

const APP_CONFIG = parseAppArgs(process.argv.slice(2));

if (APP_CONFIG.cwd) {
  try {
    process.chdir(APP_CONFIG.cwd);
  } catch (err) {
    console.error("[node] Failed to chdir to", APP_CONFIG.cwd, err.message);
  }
}

const PORT = APP_CONFIG.port;
const HOST = APP_CONFIG.host;
let busy = false;
let lastLogs = [];
let lastResult = null;
let currentToken = null;

function log(message) {
  console.log(String(message));
}
function stepLog(message) {
  const stamp = new Date().toLocaleTimeString("vi-VN", { hour12: false });
  const line = `[${stamp}]` + "\n" + String(message);
  console.log(line);
  lastLogs.push(line);
  if (lastLogs.length > 250) lastLogs = lastLogs.slice(-250);
}
async function timedStep(name, action) {
  const startedAt = Date.now();
  try { return await action(); }
  finally { stepLog(`⏱ ${name}: ${((Date.now() - startedAt) / 1000).toFixed(2)} giây`); }
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function sendHtml(res, html) {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(html);
}

function getBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", chunk => {
      data += chunk;
      if (data.length > 1024 * 1024) {
        reject(new Error("Request quá lớn"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); }
      catch (_) { reject(new Error("JSON không hợp lệ")); }
    });
    req.on("error", reject);
  });
}

function clean(v, fallback = "") {
  return v === undefined || v === null ? fallback : String(v).trim();
}

async function configureModem(cfg) {
  const warnings = [];
  MODEM_IP = clean(cfg.ip, "192.168.1.1");
  USERNAME = clean(cfg.username, "admin");
  vlan_id = clean(cfg.vlan, "11");
  PASSWORD = clean(cfg.password);
  // Mode 1: one password field is the new password.
  // Mode 2: the same field is the current password.
  PASSWORD_NEW = PASSWORD;
  slid_gpon = clean(cfg.slid);
  user_pppoe = clean(cfg.pppoeUser);
  pass_pppoe = clean(cfg.pppoePassword);
  name_wifi_2g = clean(cfg.wifi2gName, "WiFi 2.4G");
  pass_wifi_2g = clean(cfg.wifi2gPassword, "1234567890");
  name_wifi_5g = clean(cfg.wifi5gName, "WiFi 5G");
  pass_wifi_5g = clean(cfg.wifi5gPassword, "1234567890");

  if (!MODEM_IP) throw new Error("Thiếu IP modem");
  if (net.isIP(MODEM_IP) !== 4) throw new Error("IP modem phải là địa chỉ IPv4 hợp lệ");

  const mode = clean(cfg.loginMode, "1");
  if (!["1", "2"].includes(mode)) throw new Error("Chế độ đăng nhập chỉ là 1 hoặc 2");
  if (!PASSWORD) throw new Error(mode === "1" ? "Mode 1 cần nhập mật khẩu mới" : "Mode 2 cần nhập mật khẩu hiện tại");
  if (cfg.doSlid && !slid_gpon) throw new Error("Đã bật SLID nhưng chưa nhập giá trị");
  if (cfg.doPppoe && (!user_pppoe || !pass_pppoe)) throw new Error("PPPoE cần có cả tài khoản và mật khẩu");
  const doWifi5g = cfg.doWifi5g || cfg.doWifi;
  const doWifi2g = cfg.doWifi2g || cfg.doWifi;
  if ((doWifi5g && (!name_wifi_5g || pass_wifi_5g.length < 8)) || (doWifi2g && (!name_wifi_2g || pass_wifi_2g.length < 8))) {
    throw new Error("Wi-Fi cần có đủ tên mạng và mật khẩu tối thiểu 8 ký tự cho cả hai băng tần");
  }

  stepLog("Bắt đầu cấu hình modem");
  stepLog("1/4 Login: đang xử lý");
  let token;
  await timedStep("Login", async () => {
    if (mode === "1") {
      token = await login_and_get_etoken(USERNAME, "admin");
      if (!token) throw new Error("LOGIN admin/admin FAIL");
      stepLog("1/4 Login: POST đổi mật khẩu mặc định, sau đó đăng nhập lại");
      const changed = await change_first_pass(token, PASSWORD_NEW, PASSWORD_NEW);
      if (changed === null) throw new Error("ĐỔI PASSWORD FAIL");
      token = await login_and_get_etoken(USERNAME, PASSWORD_NEW);
      if (!token) throw new Error("LOGIN LẠI BẰNG PASS MỚI FAIL");
      PASSWORD = PASSWORD_NEW;
    } else {
      token = await login_and_get_etoken(USERNAME, PASSWORD);
      if (!token) throw new Error("LOGIN FAIL");
    }
  });
  currentToken = token;
  stepLog("1/4 Đăng nhập modem: xong");
  await sleep(1000);

  if (cfg.doSlid) {
    stepLog("2/4 SLID: GET CSRF rồi POST cấu hình");
    await timedStep("SLID", () => set_slid(token, slid_gpon));
    stepLog("2/4 SLID: xong");
  } else stepLog("2/4 SLID: bỏ qua");
  await sleep(1000);

  if (cfg.doPppoe) {
    stepLog("3/4 PPPoE: GET danh sách WAN/CSRF rồi POST tạo mới");
    try {
      const created = await timedStep("PPPoE", () => wan_new_pppoe(token, user_pppoe, pass_pppoe, vlan_id));
      stepLog(created ? "3/4 PPPoE: xong" : `3/4 PPPoE: VLAN ${vlan_id} đã có, giữ nguyên`);
    } catch (err) {
      const warning = `PPPoE không hoàn tất: ${err.message || err}`;
      warnings.push(warning);
      stepLog(`⚠️ ${warning}`);
      stepLog("Tiếp tục các bước còn lại.");
    }
  } else stepLog("3/4 PPPoE: bỏ qua");
  await sleep(1000);

  if (cfg.doWifi5g || cfg.doWifi) {
    stepLog("4/4 Wi-Fi 5 GHz: lấy CSRF rồi POST cấu hình");
    try {
      await timedStep("Wi-Fi 5 GHz", async () => {
        const csrf5 = await get_csrf_token_from_page(token, `https://${MODEM_IP}/cgi-bin/net-wlan11ac.asp`);
        if (!csrf5) throw new Error("Lỗi lấy token Wi-Fi 5G");
        await config_wifi_5g(token, name_wifi_5g, pass_wifi_5g, csrf5);
      });
      stepLog("4/4 Wi-Fi 5 GHz: đã nhận phản hồi");
    } catch (err) {
      const warning = `Wi-Fi 5 GHz: chưa nhận được xác nhận từ modem (${err.message || err})`;
      warnings.push(warning);
      stepLog(`⚠️ ${warning}`);
    }
  } else stepLog("4/4 Wi-Fi 5 GHz: bỏ qua");

  if (cfg.doWifi2g || cfg.doWifi) {
    if (cfg.doWifi5g || cfg.doWifi) await sleep(1000);
    stepLog("4/4 Wi-Fi 2.4 GHz: lấy CSRF rồi POST cấu hình");
    try {
      await timedStep("Wi-Fi 2.4 GHz", async () => {
        const csrf2 = await get_csrf_token_from_page(token, `https://${MODEM_IP}/cgi-bin/net-wlan.asp`);
        if (!csrf2) throw new Error("Lỗi lấy token Wi-Fi 2.4G");
        await config_wifi_2g(token, name_wifi_2g, pass_wifi_2g, csrf2);
      });
      stepLog("4/4 Wi-Fi 2.4 GHz: đã nhận phản hồi");
    } catch (err) {
      const warning = `Wi-Fi 2.4 GHz: chưa nhận được xác nhận từ modem (${err.message || err})`;
      warnings.push(warning);
      stepLog(`⚠️ ${warning}`);
    }
  } else stepLog("4/4 Wi-Fi 2.4 GHz: bỏ qua");
  stepLog("Hoàn tất cấu hình");
  return { ok: true, ip: MODEM_IP, warnings };
}

const API_PREFIX = process.env.NS_EMBED ? '/nsv1' : '';

const HTML = `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
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
.log{height:300px;overflow:auto;font:14px monospace;line-height:1.45;white-space:pre-wrap;background:#0b0d0f;padding:12px;border-radius:12px}
.note{margin-top:8px;color:#aeb6bf;font-size:13px;line-height:1.4}
@media(max-width:520px){.grid{grid-template-columns:1fr}body{font-size:17px}.wrap{padding:9px}.card{padding:14px}.header h1{font-size:24px}}
#status{display:none!important}</style>
</head>
<body><div class="wrap">
<div class="card header">
<h1>[Trần Trung Hiếu]</h1><h2>MODEM GPON NS_V1</h2>
  
  
</div>

<div class="card">
  <div class="section-title"><span class="step">1.</span>ĐĂNG NHẬP MODEM</div>
  <div class="grid">
    <div><label>Địa chỉ IP modem</label><input id="ip" value="192.168.1.1" placeholder="192.168.1.1"></div>
    <div><label>Tài khoản quản trị</label><input id="username" value="admin"></div>
  </div>
  <label>Chế độ đăng nhập modem</label>
  <select id="loginMode">
    <option value="1">1 - Modem vừa reset / đăng nhập admin/admin</option>
    <option value="2">2 - Modem đã đổi mật khẩu</option>
  </select>
  <label id="passwordLabel">Mật khẩu mới</label>
  <input id="password" placeholder="Nhập mật khẩu mới cho modem">
</div>

<div class="card">
  <div class="section-head"><div class="section-title"><span class="step">2.</span>SLID GPON</div><label class="step-toggle"><input id="doSlid" type="checkbox" checked onchange="this.nextElementSibling.textContent=this.checked?'Enable':'Disable'"><span>Enable</span></label></div>
  <label>SLID GPON</label><input id="slid" value="A00012345">
</div>

<div class="card">
  <div class="section-head"><div class="section-title"><span class="step">3.</span>CẤU HÌNH WAN PPPoE</div><label class="step-toggle"><input id="doPppoe" type="checkbox" checked onchange="this.nextElementSibling.textContent=this.checked?'Enable':'Disable'"><span>Enable</span></label></div>
  <div class="grid">
    <div><label>Tài khoản PPPoE</label><input id="pppoeUser" value="ppp_user"></div>
    <div><label>VLAN WAN</label><input id="vlan" value="11"></div>
  </div>
  <label>Mật khẩu PPPoE</label><input id="pppoePassword" value="abcd1234">
  
</div>

<div class="card">
  <div class="section-title"><span class="step">4.</span>WIFI</div>
  <div class="grid">
    <div><div class="section-head"><div class="section-title">WiFi 2.4 GHz</div><label class="step-toggle"><input id="doWifi2g" type="checkbox" checked onchange="this.nextElementSibling.textContent=this.checked?'Enable':'Disable'"><span>Enable</span></label></div><label>Tên WiFi 2.4 GHz</label><input id="wifi2gName" value="WiFi 2.4G"><label>Mật khẩu WiFi 2.4 GHz</label><input id="wifi2gPassword" value="1234567890"></div>
    <div><div class="section-head"><div class="section-title">WiFi 5 GHz</div><label class="step-toggle"><input id="doWifi5g" type="checkbox" checked onchange="this.nextElementSibling.textContent=this.checked?'Enable':'Disable'"><span>Enable</span></label></div><label>Tên WiFi 5 GHz</label><input id="wifi5gName" value="WiFi 5G"><label>Mật khẩu WiFi 5 GHz</label><input id="wifi5gPassword" value="1234567890"></div>
  </div>
</div>

<div class="card">
  <button type="button" id="run">▶ BẮT ĐẦU CẤU HÌNH</button>
  <div id="status" class="status">Sẵn sàng.</div>
</div>

<div class="card">
  <div class="section-title">📋 NHẬT KÝ</div>
  <div id="logs" class="log">Chưa có log.</div>
</div>
</div>
<script>
(function(){
  function byId(id){ return document.getElementById(id); }
  function val(id){ var el=byId(id); return el ? String(el.value || '').trim() : ''; }
  function checked(id){ var el=byId(id); return !!(el && el.checked); }
  function setStatus(t,c){ var el=byId('status'); if(!el)return; el.textContent=t; el.className='status '+(c||''); }

  async function refresh(){
    try{
      var r=await fetch('${API_PREFIX}/api/status',{cache:'no-store'});
      if(!r.ok) throw new Error('HTTP '+r.status);
      var d=await r.json();
      var logs=byId('logs');
      if(logs) logs.textContent=(d.logs && d.logs.length)?d.logs.join('\\n'):'Chưa có log.';
      var run=byId('run');
      if(run){
        run.disabled=!!d.busy;
        run.textContent=d.busy?'⏳ ĐANG CẤU HÌNH...':'▶ BẮT ĐẦU CẤU HÌNH';
      }
      if(d.busy){
        setStatus('⏳ Đang cấu hình modem...','running');
      }else if(d.result && d.result.ok){
        setStatus(d.result.warnings && d.result.warnings.length ? '⚠️ Hoàn tất nhưng có bước bị bỏ qua' : '✅ Cấu hình hoàn tất', d.result.warnings && d.result.warnings.length ? 'running' : 'ok');
      }else if(d.result && d.result.error){
        setStatus('❌ '+d.result.error,'err');
      }
    }catch(e){
      setStatus('❌ Không kết nối được API: '+e.message,'err');
    }
  }

  function updatePasswordLabel(){
    var mode=val('loginMode'), label=byId('passwordLabel'), input=byId('password');
    if(mode==='1'){
      if(label) label.textContent='Mật khẩu mới';
      if(input) input.placeholder='Nhập mật khẩu mới cho modem';
    }else{
      if(label) label.textContent='Mật khẩu hiện tại';
      if(input) input.placeholder='Nhập mật khẩu hiện tại của modem';
    }
  }
  var loginModeEl=byId('loginMode');
  if(loginModeEl) loginModeEl.addEventListener('change',updatePasswordLabel);
  updatePasswordLabel();

  async function runConfig(){
    var run=byId('run');
    if(run) run.disabled=true;
    setStatus('⏳ Đang gửi yêu cầu cấu hình...','running');
    var cfg={
      ip:val('ip'), username:val('username'), loginMode:val('loginMode'),
      password:val('password'),
      slid:val('slid'), doSlid:checked('doSlid'),
      pppoeUser:val('pppoeUser'), pppoePassword:val('pppoePassword'),
      vlan:val('vlan'), doPppoe:checked('doPppoe'),
      wifi2gName:val('wifi2gName'), wifi2gPassword:val('wifi2gPassword'),
      wifi5gName:val('wifi5gName'), wifi5gPassword:val('wifi5gPassword'),
      doWifi2g:checked('doWifi2g'), doWifi5g:checked('doWifi5g')
    };
    try{
      if(!cfg.ip) throw new Error('Chưa nhập IP modem');
      var r=await fetch('${API_PREFIX}/api/configure',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(cfg),cache:'no-store'});
      var d=await r.json();
      if(!r.ok || !d.ok) throw new Error(d.error || ('HTTP '+r.status));
      setStatus('✅ Đã bắt đầu cấu hình. Xem Nhật ký bên dưới.','running');
      await refresh();
    }catch(e){
      setStatus('❌ '+e.message,'err');
      if(run) run.disabled=false;
    }
  }

  function bind(){
    var run=byId('run');
    if(!run){ setStatus('❌ Không tìm thấy nút điều khiển.','err'); return; }
    run.type='button';
    run.addEventListener('click',function(ev){ev.preventDefault();runConfig();});
    setStatus('Sẵn sàng. Nút đã được kết nối.','');
    // Xóa nhật ký phiên trước khi mở form; không ảnh hưởng luồng cấu hình.
    fetch('${API_PREFIX}/api/logs',{method:'DELETE',cache:'no-store'}).then(refresh).catch(refresh);
    setInterval(refresh,1000);
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',bind); else bind();
})();
</script></body></html>`;

function queryBool(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function configurePage(title, apiPrefix) {
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title} - Nhật ký cấu hình</title><style>
  *{box-sizing:border-box}body{margin:0;background:#101418;color:#eef2f6;font:16px Arial,sans-serif}
  main{max-width:850px;margin:24px auto;padding:12px}.card{background:#1b222a;border:1px solid #35404c;border-radius:14px;padding:18px}
  h2{margin:0 0 8px;font-size:22px}.muted{color:#aab6c2;font-size:13px}.status{margin:14px 0;padding:12px;border-radius:9px;background:#111820;color:#ffd166;font-weight:bold}
  pre{margin:0;height:65vh;min-height:300px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;background:#080c10;border-radius:9px;padding:14px;color:#d8e4ef;font:13px/1.55 Consolas,monospace}
  @media(max-width:600px){main{margin:0;padding:8px}.card{padding:12px}pre{height:72vh}}
  #status{display:none!important}</style></head><body><main><section class="card"><h2>📋 ${title}</h2><div class="muted">Nhật ký cập nhật tự động. Không đóng trang trong khi modem đang cấu hình.</div>
  <div id="status" class="status">Đang kết nối...</div><pre id="logs">Đang chờ nhật ký...</pre></section></main>
  <script>
  (function(){
    // Xóa toàn bộ tham số chứa mật khẩu khỏi thanh địa chỉ sau khi server đã nhận yêu cầu.
    try{history.replaceState(null,'',location.pathname+'?view=1');}catch(e){}
    const statusEl=document.getElementById('status'), logsEl=document.getElementById('logs');
    // Tự nhận diện đường dẫn khi chạy độc lập hoặc thông qua proxy /nsv1.
    const apiBase = location.pathname.startsWith('/nsv1/') ? '/nsv1' : '${apiPrefix}';
    async function refresh(){try{
      const r=await fetch(apiBase+'/api/status',{cache:'no-store'});
      if(!r.ok) throw new Error('HTTP '+r.status+' tại '+apiBase+'/api/status');
      const d=await r.json();
      logsEl.textContent=(d.logs&&d.logs.length)?d.logs.join('\\n'):'Chưa có nhật ký.';
      const active=!!(d.busy===true || d.running===true);
      statusEl.textContent=active?'⏳ ĐANG CẤU HÌNH MODEM...':(d.result&&d.result.ok===false?'❌ CẤU HÌNH CÓ LỖI':(d.result&&d.result.warnings&&d.result.warnings.length?'⚠️ HOÀN TẤT NHƯNG CÓ BƯỚC BỊ BỎ QUA':'✅ ĐÃ DỪNG / HOÀN TẤT'));
      logsEl.scrollTop=logsEl.scrollHeight;
    }catch(e){statusEl.textContent='Mất kết nối nhật ký: '+e.message;} }
    refresh();setInterval(refresh,1000);
  })();
  </script></body></html>`;
}

function configFromQuery(params) {
  return {
    ip: params.get("ip") || "192.168.1.1",
    username: params.get("username") || "admin",
    loginMode: params.get("loginMode") || params.get("mode") || "1",
    password: params.get("password") || params.get("modemPass") || "",
    slid: params.get("slid") || "",
    doSlid: queryBool(params.get("doSlid")),
    pppoeUser: params.get("pppoeUser") || "",
    pppoePassword: params.get("pppoePassword") || params.get("pppoePass") || "",
    vlan: params.get("vlan") || "11",
    doPppoe: queryBool(params.get("doPppoe")),
    wifi2gName: params.get("wifi2gName") || params.get("wifi2g") || "WiFi 2.4G",
    wifi2gPassword: params.get("wifi2gPassword") || params.get("pass2g") || "",
    wifi5gName: params.get("wifi5gName") || params.get("wifi5g") || "WiFi 5G",
    wifi5gPassword: params.get("wifi5gPassword") || params.get("pass5g") || "",
    doWifi: queryBool(params.get("doWifi")),
    doWifi2g: queryBool(params.get("doWifi2g")) || queryBool(params.get("doWifi")),
    doWifi5g: queryBool(params.get("doWifi5g")) || queryBool(params.get("doWifi"))
  };
}

function startConfigureFromUrl(res, url) {
  if (busy) return sendHtml(res, '<h2>Đang có một phiên cấu hình khác chạy. Hãy chờ hoàn tất.</h2>');
  const cfg = configFromQuery(url.searchParams);
  if (!cfg.ip || !cfg.password) return sendHtml(res, '<h2>Thiếu tham số bắt buộc: ip và password (mật khẩu modem).</h2><p>Ví dụ: /configure?ip=192.168.1.1&loginMode=2&password=...</p>');
  if (!["1", "2"].includes(cfg.loginMode)) return sendHtml(res, '<h2>loginMode chỉ nhận 1 hoặc 2.</h2>');
  busy = true; lastLogs = []; lastResult = null;
  // Không ghi query string hoặc mật khẩu vào nhật ký.
  configureModem(cfg).then(r => { lastResult = r || {ok:true}; })
    .catch(e => { lastResult = {ok:false,error:e.message || String(e)}; stepLog("Lỗi: " + lastResult.error); })
    .finally(() => { busy = false; });
  return sendHtml(res, configurePage("CẤU HÌNH MODEM NS V1", process.env.NS_EMBED ? "/nsv1" : ""));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
    if (req.method === "GET" && url.pathname === "/configure") {
      if (url.searchParams.get("view") === "1") return sendHtml(res, configurePage("CẤU HÌNH MODEM NS V1", process.env.NS_EMBED ? "/nsv1" : ""));
      return startConfigureFromUrl(res, url);
    }
    if (req.method === "GET" && url.pathname === "/") return sendHtml(res, HTML);
    if (req.method === "GET" && url.pathname === "/api/status") return sendJson(res, 200, {ok:true,busy,logs:lastLogs,result:lastResult});
    if (req.method === "DELETE" && url.pathname === "/api/logs") { lastLogs=[]; lastResult=null; return sendJson(res,200,{ok:true}); }
    if (req.method === "POST" && url.pathname === "/api/configure") {
      if (busy) return sendJson(res, 409, {ok:false,error:"Đang có một phiên cấu hình khác chạy."});
      const cfg = await getBody(req);
      busy=true; lastLogs=[]; lastResult=null;
      configureModem(cfg).then(r=>{lastResult=r;}).catch(e=>{lastResult={ok:false,error:e.message||String(e)};stepLog(`Lỗi: ${lastResult.error}`);}).finally(()=>{busy=false;});
      return sendJson(res,202,{ok:true,message:"Đã bắt đầu cấu hình"});
    }
    res.writeHead(404);res.end("Not Found");
  } catch(e) { sendJson(res,500,{ok:false,error:e.message||String(e)}); }
});

if (!process.env.NS_EMBED) {
  server.listen(PORT, HOST, () => {
    console.log(`[node] listening on http://${HOST}:${PORT}`);
    console.log("============================================");
    console.log(`MODEM WEB SERVER ĐANG CHẠY: http://${HOST}:${PORT}`);
    console.log(`MỞ TRÌNH DUYỆT: http://${HOST}:${PORT}`);
    console.log("============================================");
  });
}

module.exports = { server };

server.on("error", (err) => {
  console.error("[node] server error:", err);
  process.exitCode = 1;
});

process.on("uncaughtException", (err) => {
  console.error("[node] uncaught exception:", err);
});


