// G040H - URL CONFIGURATOR (log-only UI)
// API flow reconstructed from the supplied g040h.har capture.
// Run as a service behind the main launcher: PORT=3004 node g040h.js
"use strict";

const https = require("https");
const http = require("http");
const net = require("net");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const G040H_EMBED = process.env.G040H_EMBED === "1";
const MAX_LOGS = 600;
let busy = false;
let logs = [];
let rawLogs = [];
let lastResult = null;
let activeIp = "";
let cookies = {};
const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true, maxSockets: 2 });

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function log(message) {
  const safe=String(message).replace(/(password|passwd|token|sessionkey|cookie|secret)(\s*[=:]\s*)[^,; ]+/ig,"$1$2[REDACTED]").replace(/\[HTTP<\] Body đầu:.*$/i,"[HTTP<] Body đầu: [đã ẩn dữ liệu phản hồi]");
  const line=`[${new Date().toLocaleTimeString("vi-VN", {hour12:false})}]\n${safe}`; rawLogs.push(line); if(rawLogs.length>MAX_LOGS) rawLogs.shift();
  console.log(String(message));
}
function stepLog(message) {
  const stamp = new Date().toLocaleTimeString("vi-VN", { hour12: false });
  const line = `[${stamp}]` + "\n" + String(message);
  logs.push(line); rawLogs.push(line);
  if (logs.length > MAX_LOGS) logs.shift(); if (rawLogs.length > MAX_LOGS) rawLogs.shift();
  console.log(line);
}
async function timedStep(name, action) {
  const startedAt = Date.now();
  try { return await action(); }
  finally { stepLog(`⏱ ${name}: ${((Date.now() - startedAt) / 1000).toFixed(2)} giây`); }
}
function formEncode(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) p.append(k, String(v ?? ""));
  return p.toString();
}
function parseCookieHeaders(headers) {
  const all = headers["set-cookie"] || [];
  for (const item of all) {
    const first = item.split(";")[0];
    const i = first.indexOf("=");
    if (i > 0) cookies[first.slice(0, i).trim()] = first.slice(i + 1).trim();
  }
}
function cookieHeader() {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
}
function rememberJavascriptAuth(html) {
  // Chỉ lấy auth dạng hash từ trang index đã đăng nhập.
  // Trang login.asp cũng có biến auth = "uid =" + ... nên không được nhầm thành cookie md5.
  const m = String(html || "").match(/\bvar\s+auth\s*=\s*["'](\$1\$[^"']+)["']/i);
  if (m && m[1]) {
    cookies.md5 = m[1];
    delete cookies.base64;
  }
}
function setLoginBase64Cookie(username, password) {
  // Mô phỏng đúng submitform() của login.asp:
  // auth = "uid =" + username + "; psw=" + password;
  // document.cookie = "base64 = " + Base64Encoding(auth) + ";path=/;";
  const auth = `uid =${username}; psw=${password}`;
  cookies.base64 = Buffer.from(auth, "utf8").toString("base64");
  delete cookies.md5;
}
function modemRequest(method, path, body = "", extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    if (!activeIp) return reject(new Error("Chưa xác định IP modem"));
    let responseSeen = false;
    let settled = false;
    let responseInfo = null;
    let responseChunks = [];
    const finishResolve = value => { if (!settled) { settled = true; resolve(value); } };
    const finishReject = error => { if (!settled) { settled = true; reject(error); } };
    const url = new URL(`https://${activeIp}${path}`);
    const headers = {
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "vi,en-US;q=0.9,en;q=0.8",
      "Connection": "keep-alive",
      "Upgrade-Insecure-Requests": "1",
      "User-Agent": "Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/156.0.0.0 Mobile Safari/537.36",
      ...extraHeaders
    };
    const ck = cookieHeader();
    if (ck) headers.Cookie = ck;
    const cookieNames = Object.keys(cookies);
    log(`[HTTP>] ${method} ${url.href}`);
    log(`[HTTP>] Referer=${headers.Referer || "(trống)"}; Cookie=${cookieNames.join(",") || "(trống)"}; Body=${body ? `${Buffer.byteLength(body)} byte` : "(trống)"}`);
    if (body) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      headers["Content-Length"] = Buffer.byteLength(body);
    }
    const req = https.request({
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method,
      headers,
      agent,
      rejectUnauthorized: false,
      timeout: 30000
    }, res => {
      responseSeen = true;
      responseInfo = { status: res.statusCode || 0, headers: res.headers };
      responseChunks = [];
      res.on("data", chunk => responseChunks.push(chunk));
      res.on("end", () => {
        try {
          let status = res.statusCode || 0;
          const headers = { ...res.headers };
          let text = Buffer.concat(responseChunks).toString("utf8");
          // The Android bridge can wrap the modem's HTTP response inside an outer HTTP 200 body.
          const wrapped = text.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})[^\r\n]*\r?\n([\s\S]*)$/i);
          if (wrapped) {
            status = Number(wrapped[1]);
            const inner = wrapped[2];
            const split = inner.search(/\r?\n\r?\n/);
            if (split >= 0) {
              const headerText = inner.slice(0, split);
              text = inner.slice(split).replace(/^\r?\n\r?\n/, "");
              const innerCookies = [];
              for (const line of headerText.split(/\r?\n/)) {
                const match = line.match(/^([^:]+):\s*(.*)$/);
                if (!match) continue;
                const name = match[1].toLowerCase();
                if (name === "set-cookie") innerCookies.push(match[2]);
                else headers[name] = match[2];
              }
              if (innerCookies.length) headers["set-cookie"] = innerCookies;
            } else text = inner;
            log(`[HTTP<] Modem HTTP ${status} được bọc trong phản hồi bridge HTTP ${res.statusCode || 0}`);
          }
          responseInfo = { status, headers };
          parseCookieHeaders(headers);
          rememberJavascriptAuth(text);
          const setCookie = headers["set-cookie"] || [];
          const setCookieList = Array.isArray(setCookie) ? setCookie : [setCookie];
          const setCookieNames = setCookieList.map(v => String(v).split("=")[0].trim()).join(",") || "(không có)";
          log(`[HTTP<] ${method} ${path} => ${status}; location=${headers.location || "(không có)"}; Set-Cookie=${setCookieNames}; body=${text.length} ký tự`);
          if (status >= 400) log(`[HTTP<] Body đầu: ${text.slice(0, 220).replace(/[\r\n\t]+/g, " ")}`);
          finishResolve({ status, headers, text });
        } catch (error) {
          log(`[HTTP!] Lỗi xử lý phản hồi ${method} ${path}: ${error && error.stack || error}`);
          finishReject(error);
        }
      });
      res.on("aborted", () => {
        const text = Buffer.concat(responseChunks).toString("utf8");
        if (responseInfo && responseInfo.status < 400) {
          log(`[HTTP!] ${method} ${path}: modem đóng luồng sau khi trả HTTP ${responseInfo.status}; tiếp tục với phần phản hồi đã nhận (${text.length} ký tự)`);
          parseCookieHeaders(responseInfo.headers);
          rememberJavascriptAuth(text);
          finishResolve({ ...responseInfo, text });
        } else {
          finishReject(new Error(`Phản hồi ${method} ${path} bị ngắt giữa chừng`));
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("Modem không phản hồi trong 30 giây")));
    req.on("error", err => {
      if (responseSeen && responseInfo && responseInfo.status < 400) {
        const text = Buffer.concat(responseChunks).toString("utf8");
        log(`[HTTP!] Socket bị ngắt sau khi modem đã trả HTTP ${responseInfo.status} cho ${method} ${path}: ${err.message}`);
        parseCookieHeaders(responseInfo.headers);
        rememberJavascriptAuth(text);
        finishResolve({ ...responseInfo, text });
      } else {
        finishReject(err);
      }
    });
    if (body) req.write(body);
    req.end();
  });
}
function pageHeaders(path) {
  return {
    "Referer": `https://${activeIp}${path}`,
    "Origin": `https://${activeIp}`
  };
}
async function getPage(path) {
  const r = await modemRequest("GET", path, "", pageHeaders(path));
  if (r.status >= 400) throw new Error(`GET ${path} trả HTTP ${r.status}`);
  return r.text;
}
async function postPage(path, payload) {
  const body = formEncode(payload);
  return modemRequest("POST", path, body, pageHeaders(path));
}
function csrfFrom(html) {
  const patterns = [
    /name\s*=\s*["']CsrfToken["'][^>]*value\s*=\s*["']([^"']+)["']/i,
    /value\s*=\s*["']([^"']+)["'][^>]*name\s*=\s*["']CsrfToken["']/i
  ];
  for (const re of patterns) {
    const m = String(html || "").match(re);
    if (m) return m[1];
  }
  return "";
}
function inputValue(html, name) {
  const tags = String(html || "").match(/<input\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const nm = tag.match(/\bname\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    if (!nm || (nm[1] ?? nm[2] ?? nm[3]) !== name) continue;
    const vm = tag.match(/\bvalue\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    return vm ? (vm[1] ?? vm[2] ?? vm[3] ?? "") : "";
  }
  return null;
}
function wanEntriesFromHtml(html) {
  const source = String(html || "");
  const match = source.match(/\bvar\s+pvc_info\s*=\s*\[([\s\S]*?)\]\s*;/i);
  if (!match) return null;
  const rows = match[1].match(/\[(?:\s*"(?:\\.|[^"\\])*"\s*,?\s*){15}\]/g) || [];
  return rows.map((row, index) => {
    const values = (row.match(/"(?:\\.|[^"\\])*"/g) || []).map(value => {
      try { return JSON.parse(value); } catch (_) { return value.slice(1, -1); }
    });
    return { index, created: values[0] || "No", isp: values[6] || "", vlan: values[9] || "" };
  });
}
function isLoginPage(html) {
  return /name\s*=\s*["']Auth_Password["']/i.test(String(html || ""));
}
function clonePairs(pairs) {
  const out = {};
  for (const [k, v] of pairs) out[k] = v;
  return out;
}

const WAN_TEMPLATE = clonePairs([
  [
    "submit_disable",
    "No"
  ],
  [
    "hidEncapFlag",
    "0"
  ],
  [
    "hidEncap",
    "0"
  ],
  [
    "wanIsCreated",
    "Yes"
  ],
  [
    "editFlag",
    "0"
  ],
  [
    "EditingWan",
    "-1"
  ],
  [
    "isIPv6Supported",
    "1"
  ],
  [
    "DynIPv6Enable_flag",
    "1"
  ],
  [
    "PPPDHCPv6Enable_Flag",
    "N/A"
  ],
  [
    "PPPDHCPv6Mode_Flag",
    "0"
  ],
  [
    "IPv6PD_Flag",
    "1"
  ],
  [
    "IPv6PD_Flag_Default",
    "Yes"
  ],
  [
    "DHCP6SMode_Flag",
    "0"
  ],
  [
    "IPVERSION_IPv4",
    "IPv4"
  ],
  [
    "wanTransFlag",
    "0"
  ],
  [
    "wanBarrierFlag",
    "0"
  ],
  [
    "ptm_VC",
    "8"
  ],
  [
    "wanVCFlag",
    "3"
  ],
  [
    "service_num_flag",
    "0"
  ],
  [
    "wanSaveFlag",
    "1"
  ],
  [
    "vciCheckFlag",
    "0"
  ],
  [
    "wanEncapFlag",
    "0"
  ],
  [
    "DSLITE_MANUAL_MODE",
    "1"
  ],
  [
    "IPVersion_Flag",
    "0"
  ],
  [
    "newVLANFlag",
    "1"
  ],
  [
    "is8021xsupport",
    "0"
  ],
  [
    "isDSLITESupported",
    "1"
  ],
  [
    "wan_8021q",
    "1"
  ],
  [
    "disp_wan_8021q",
    "1"
  ],
  [
    "DefaultWan_Active",
    "No"
  ],
  [
    "DefaultWan_ISP",
    "3"
  ],
  [
    "DefaultWan_IPVERSION",
    "IPv4"
  ],
  [
    "DefaultWan_MLDproxy",
    "N/A"
  ],
  [
    "ipv6SupportValue",
    "0"
  ],
  [
    "UserMode",
    "0"
  ],
  [
    "wan_certificate",
    "N/A"
  ],
  [
    "wan_CA",
    "N/A"
  ],
  [
    "wan_HiddenBiDirectionalAuth",
    "N/A"
  ],
  [
    "IPv6PrivacyAddrsSupportedFlag",
    "N/A"
  ],
  [
    "wan_TransMode",
    "Fiber"
  ],
  [
    "wan_VC",
    "1"
  ],
  [
    "wan_VCStatus",
    "Yes"
  ],
  [
    "ipVerRadio",
    "IPv4/IPv6"
  ],
  [
    "wanTypeRadio",
    "2"
  ],
  [
    "wan_dot1q",
    "Yes"
  ],
  [
    "wan_vid",
    "11"
  ],
  [
    "wan_dot1pRemark",
    "Remark"
  ],
  [
    "wan_dot1p",
    "0"
  ],
  [
    "wan_mvlan",
    "-1"
  ],
  [
    "wan_FIREWALL",
    "Enable"
  ],
  [
    "wan_TCPBridge",
    "1500"
  ],
  [
    "wan_status",
    "Disabled"
  ],
  [
    "wan_eapIdentity",
    ""
  ],
  [
    "wan_authentication",
    "on"
  ],
  [
    "wan_BridgeInterface0",
    "No"
  ],
  [
    "WAN_DefaultRoute0",
    "No"
  ],
  [
    "wan_TCPMTU0",
    "1500"
  ],
  [
    "wan_NAT0",
    "Enable"
  ],
  [
    "wan_RIP0",
    "RIP1"
  ],
  [
    "wan_RIP_Dir0",
    "None"
  ],
  [
    "wan_IGMP0",
    "No"
  ],
  [
    "DynIPv6EnableRadio",
    "1"
  ],
  [
    "PPPIPv6PDRadio0",
    "Yes"
  ],
  [
    "wan_MLD0",
    "No"
  ],
  [
    "DSLITEEnableRadio0",
    "No"
  ],
  [
    "DSLITEModeRadio0",
    "0"
  ],
  [
    "wan_BridgeInterface1",
    "No"
  ],
  [
    "WAN_DefaultRoute1",
    "No"
  ],
  [
    "wan_TCPMTU1",
    "1500"
  ],
  [
    "wan_StaticIPaddr1",
    ""
  ],
  [
    "wan_StaticIPSubMask1",
    ""
  ],
  [
    "wan_StaticIpGateway1",
    ""
  ],
  [
    "wan_NAT1",
    "Enable"
  ],
  [
    "wan_RIP1",
    "RIP1"
  ],
  [
    "wan_RIP_Dir1",
    "None"
  ],
  [
    "wan_IGMP1",
    "No"
  ],
  [
    "wan_IPv6Addr",
    ""
  ],
  [
    "wan_IPv6Prefix",
    ""
  ],
  [
    "wan_IPv6DefGw",
    ""
  ],
  [
    "wan_IPv6DNS1",
    ""
  ],
  [
    "wan_IPv6DNS2",
    ""
  ],
  [
    "wan_MLD1",
    "No"
  ],
  [
    "DSLITEEnableRadio1",
    "No"
  ],
  [
    "DSLITEAddr1",
    ""
  ],
  [
    "TTNETGuiSupport",
    "0"
  ],
  [
    "wan_BridgeInterface2",
    "No"
  ],
  [
    "wan_ConnectSelect",
    "Connect_Keep_Alive"
  ],
  [
    "wan_TCPMSS",
    "0"
  ],
  [
    "WAN_DefaultRoute2",
    "Yes"
  ],
  [
    "wan_PPPGetIP",
    "Dynamic"
  ],
  [
    "wan_NAT2",
    "Enable"
  ],
  [
    "wan_RIP2",
    "RIP1"
  ],
  [
    "wan_RIP_Dir2",
    "None"
  ],
  [
    "wan_TCPMTU2",
    "1492"
  ],
  [
    "wan_IGMP2",
    "No"
  ],
  [
    "PPPIPv6ModeRadio",
    "0"
  ],
  [
    "PPPIPv6PDRadio2",
    "Yes"
  ],
  [
    "wan_MLD2",
    "No"
  ],
  [
    "DSLITEEnableRadio2",
    "No"
  ],
  [
    "DSLITEModeRadio2",
    "0"
  ],
  [
    "DSLITEAddr2",
    ""
  ],
  [
    "isPPPAuthen",
    "N/A"
  ],
  [
    "isWanTagChk",
    "N/A"
  ],
  [
    "isdot1pSupport",
    "Yes"
  ],
  [
    "isTPIDSupported",
    "N/A"
  ],
  [
    "DefaultDmz_Active",
    "No"
  ],
  [
    "DefaultDmz_HostIP",
    "0.0.0.0"
  ],
  [
    "delWanFlag",
    "0"
  ]
]);
const WIFI5_TEMPLATE = clonePairs([
  [
    "isWPSSupported",
    "1"
  ],
  [
    "WscV2Support",
    "0"
  ],
  [
    "BasicRate_Value1",
    "15"
  ],
  [
    "BasicRate_Value2",
    "3"
  ],
  [
    "BasicRate_Value3",
    "351"
  ],
  [
    "CountryRegionABand0",
    "0"
  ],
  [
    "CountryRegionABand1",
    "1"
  ],
  [
    "CountryRegionABand2",
    "2"
  ],
  [
    "CountryRegionABand3",
    "3"
  ],
  [
    "CountryRegionABand4",
    "4"
  ],
  [
    "CountryRegionABand5",
    "5"
  ],
  [
    "CountryRegionABand6",
    "6"
  ],
  [
    "CountryRegionABand7",
    "7"
  ],
  [
    "CountryRegionABand8",
    "8"
  ],
  [
    "CountryRegionABand9",
    "9"
  ],
  [
    "CountryRegionABand10",
    "10"
  ],
  [
    "CountryRegionABand11",
    "11"
  ],
  [
    "CountryRegionABand12",
    "12"
  ],
  [
    "CountryRegionABand13",
    "13"
  ],
  [
    "CountryRegionABand14",
    "14"
  ],
  [
    "HTMCSAUTO",
    "33"
  ],
  [
    "HTBW",
    "0"
  ],
  [
    "VHTBW",
    "0"
  ],
  [
    "RTDEVICE",
    "7615"
  ],
  [
    "WEP_Key",
    "0"
  ],
  [
    "VHTSec80Channel",
    "0"
  ],
  [
    "WLan11acITxBfEn",
    "0"
  ],
  [
    "WLan11acETxBfEnCond",
    "0"
  ],
  [
    "WLan11acETxBfIncapable",
    "1"
  ],
  [
    "WPSConfigured",
    "2"
  ],
  [
    "WpsConfModeAll",
    "7"
  ],
  [
    "WpsConfModeNone",
    "0"
  ],
  [
    "WpsStart",
    "0"
  ],
  [
    "WpsOOB",
    "0"
  ],
  [
    "isInWPSing",
    "0"
  ],
  [
    "WpsGenerate",
    "0"
  ],
  [
    "Is11nMode",
    "1"
  ],
  [
    "Is11acMode",
    "1"
  ],
  [
    "Wlan_HTBW40M",
    "1"
  ],
  [
    "ExtChannFlag",
    "0"
  ],
  [
    "isAuthenTypeSupported",
    "0"
  ],
  [
    "isDot1XSupported",
    "0"
  ],
  [
    "isDot1XEnhanceSupported",
    "0"
  ],
  [
    "wlan_VC",
    "0"
  ],
  [
    "BssidNum",
    "4"
  ],
  [
    "CountryName",
    "UNITED STATES"
  ],
  [
    "hCountryRegionABand",
    "13"
  ],
  [
    "hRekeyMethod",
    "TIME"
  ],
  [
    "isWDSSupported",
    "1"
  ],
  [
    "WDS_EncrypType_NONE",
    "NONE"
  ],
  [
    "WDS_EncrypType_WEP",
    "WEP"
  ],
  [
    "EnableACSInterval",
    "1"
  ],
  [
    "bharti_ssid2",
    "0"
  ],
  [
    "isPerSSIDSupport",
    "1"
  ],
  [
    "SSID_INDEX",
    "0"
  ],
  [
    "ESSID_Enable_Selection",
    "1"
  ],
  [
    "validESSIDflag",
    "1"
  ],
  [
    "ESSID_HIDE_Selection",
    "0"
  ],
  [
    "WMM_Selection",
    "0"
  ],
  [
    "UseWPS_Selection",
    "0"
  ],
  [
    "WPSMode_Selection",
    "1"
  ],
  [
    "WEP_Selection",
    "WPAPSKWPA2PSK"
  ],
  [
    "wlanWEPFlag",
    "3"
  ],
  [
    "WEP_TypeSelection1",
    "WEPAuto"
  ],
  [
    "DefWEPKey3",
    "1"
  ],
  [
    "WEP_Key13",
    ""
  ],
  [
    "WEP_Key23",
    ""
  ],
  [
    "WEP_Key33",
    ""
  ],
  [
    "WEP_Key43",
    ""
  ],
  [
    "WEP_TypeSelection2",
    "WEPAuto"
  ],
  [
    "DefWEPKey4",
    "1"
  ],
  [
    "WEP_Key14",
    ""
  ],
  [
    "WEP_Key24",
    ""
  ],
  [
    "WEP_Key34",
    ""
  ],
  [
    "WEP_Key44",
    ""
  ],
  [
    "TKIP_Selection4",
    "AES"
  ],
  [
    "keyRenewalInterval1",
    "3600"
  ],
  [
    "TKIP_Selection5",
    "AES"
  ],
  [
    "keyRenewalInterval2",
    "3600"
  ],
  [
    "TKIP_Selection6",
    "AES"
  ],
  [
    "keyRenewalInterval3",
    "3600"
  ],
  [
    "wlan_APenable",
    "1"
  ],
  [
    "Countries_Channels",
    "UNITED STATES"
  ],
  [
    "Channel_ID",
    "0"
  ],
  [
    "BeaconInterval",
    "100"
  ],
  [
    "TxPower",
    "100"
  ],
  [
    "TxPowerSetFlag",
    "0"
  ],
  [
    "RTSThreshold",
    "2347"
  ],
  [
    "FragmentThreshold",
    "2346"
  ],
  [
    "DTIM",
    "1"
  ],
  [
    "WirelessMode",
    "14"
  ],
  [
    "maxStaNum",
    "30"
  ],
  [
    "StationNum",
    "30"
  ],
  [
    "WLANChannelBandwidth",
    "1"
  ],
  [
    "WLANGuardInterval",
    "1"
  ],
  [
    "WLANMCS",
    "33"
  ],
  [
    "WLan11acVHTChannelBandwidth",
    "2"
  ],
  [
    "WLan11acTxBeamForming",
    "0"
  ],
  [
    "WLan11acVHTGuardInterval",
    "1"
  ],
  [
    "WLAN_WDS_Active",
    "0"
  ],
  [
    "WDS_EncrypType_Selection",
    "NONE"
  ],
  [
    "WLANWDS_PEER_MAC1",
    "00:00:00:00:00:00"
  ],
  [
    "WLANWDS_PEER_MAC2",
    "00:00:00:00:00:00"
  ],
  [
    "WLANWDS_PEER_MAC3",
    "00:00:00:00:00:00"
  ],
  [
    "WLANWDS_PEER_MAC4",
    "00:00:00:00:00:00"
  ],
  [
    "WLAN_FltActive",
    "0"
  ],
  [
    "WLAN_FltAction",
    "1"
  ],
  [
    "TxStream_Action",
    "2"
  ],
  [
    "RxStream_Action",
    "2"
  ],
  [
    "CountryChange",
    "0"
  ]
]);
const WIFI2_TEMPLATE = clonePairs([
  [
    "isWPSSupported",
    "1"
  ],
  [
    "WscV2Support",
    "0"
  ],
  [
    "BasicRate_Value1",
    "15"
  ],
  [
    "BasicRate_Value2",
    "3"
  ],
  [
    "BasicRate_Value3",
    "351"
  ],
  [
    "CountryRegion0",
    "0"
  ],
  [
    "CountryRegion1",
    "1"
  ],
  [
    "CountryRegion2",
    "2"
  ],
  [
    "CountryRegion3",
    "3"
  ],
  [
    "CountryRegion5",
    "5"
  ],
  [
    "CountryRegion6",
    "6"
  ],
  [
    "HTMCSAUTO",
    "33"
  ],
  [
    "HTBW",
    "0"
  ],
  [
    "WPSConfigured",
    "2"
  ],
  [
    "WpsConfModeAll",
    "7"
  ],
  [
    "WpsConfModeNone",
    "0"
  ],
  [
    "WpsStart",
    "0"
  ],
  [
    "WpsOOB",
    "0"
  ],
  [
    "isInWPSing",
    "0"
  ],
  [
    "WpsGenerate",
    "0"
  ],
  [
    "Is11nMode",
    "1"
  ],
  [
    "is11nSpecComply",
    "N/A"
  ],
  [
    "isWPA2PreAuthSupported",
    "N/A"
  ],
  [
    "Wlan_HTBW40M",
    "1"
  ],
  [
    "ExtChannFlag",
    "0"
  ],
  [
    "isAuthenTypeSupported",
    "0"
  ],
  [
    "isDot1XSupported",
    "0"
  ],
  [
    "isDot1XEnhanceSupported",
    "0"
  ],
  [
    "wlan_VC",
    "0"
  ],
  [
    "BssidNum",
    "4"
  ],
  [
    "CountryName",
    "UNITED STATES"
  ],
  [
    "hCountryRegion",
    "0"
  ],
  [
    "hRekeyMethod",
    "TIME"
  ],
  [
    "isWDSSupported",
    "1"
  ],
  [
    "WDS_EncrypType_NONE",
    "NONE"
  ],
  [
    "WDS_EncrypType_WEP",
    "WEP"
  ],
  [
    "bharti_ssid2",
    "0"
  ],
  [
    "isPerSSIDSupport",
    "1"
  ],
  [
    "RTDEVICE",
    "7615"
  ],
  [
    "WLanITxBfEn",
    "N/A"
  ],
  [
    "WLanETxBfEnCond",
    "N/A"
  ],
  [
    "WLanETxBfIncapable",
    "N/A"
  ],
  [
    "WEP_Key",
    "0"
  ],
  [
    "moreinfo",
    "0"
  ],
  [
    "EnableACSInterval",
    "1"
  ],
  [
    "SSID_INDEX",
    "0"
  ],
  [
    "ESSID_Enable_Selection",
    "1"
  ],
  [
    "validESSIDflag",
    "1"
  ],
  [
    "ESSID_HIDE_Selection",
    "0"
  ],
  [
    "WMM_Selection",
    "0"
  ],
  [
    "UseWPS_Selection",
    "0"
  ],
  [
    "WPSMode_Selection",
    "1"
  ],
  [
    "WEP_Selection",
    "WPAPSKWPA2PSK"
  ],
  [
    "wlanWEPFlag",
    "3"
  ],
  [
    "WEP_TypeSelection1",
    "WEPAuto"
  ],
  [
    "DefWEPKey3",
    "1"
  ],
  [
    "WEP_Key13",
    ""
  ],
  [
    "WEP_Key23",
    ""
  ],
  [
    "WEP_Key33",
    ""
  ],
  [
    "WEP_Key43",
    ""
  ],
  [
    "WEP_TypeSelection2",
    "WEPAuto"
  ],
  [
    "DefWEPKey4",
    "1"
  ],
  [
    "WEP_Key14",
    ""
  ],
  [
    "WEP_Key24",
    ""
  ],
  [
    "WEP_Key34",
    ""
  ],
  [
    "WEP_Key44",
    ""
  ],
  [
    "TKIP_Selection4",
    "AES"
  ],
  [
    "keyRenewalInterval1",
    "3600"
  ],
  [
    "TKIP_Selection5",
    "AES"
  ],
  [
    "keyRenewalInterval2",
    "3600"
  ],
  [
    "TKIP_Selection6",
    "AES"
  ],
  [
    "keyRenewalInterval3",
    "3600"
  ],
  [
    "wlan_APenable",
    "1"
  ],
  [
    "Countries_Channels",
    "UNITED STATES"
  ],
  [
    "Channel_ID",
    "0"
  ],
  [
    "BeaconInterval",
    "100"
  ],
  [
    "TxPower",
    "75"
  ],
  [
    "TxPowerSetFlag",
    "0"
  ],
  [
    "RTSThreshold",
    "2347"
  ],
  [
    "FragmentThreshold",
    "2346"
  ],
  [
    "DTIM",
    "1"
  ],
  [
    "WirelessMode",
    "9"
  ],
  [
    "maxStaNum",
    "30"
  ],
  [
    "StationNum",
    "30"
  ],
  [
    "BandSteering",
    "0"
  ],
  [
    "BandSteerModeFLag",
    "1"
  ],
  [
    "RSSI2GTo5G",
    "-60"
  ],
  [
    "RSSI5GTo2G",
    "-78"
  ],
  [
    "AirTimeFairness",
    "0"
  ],
  [
    "AirTimeFairnessModeFLag",
    "1"
  ],
  [
    "WLANChannelBandwidth",
    "0"
  ],
  [
    "WLANExtensionChannel",
    "0"
  ],
  [
    "WLANGuardInterval",
    "1"
  ],
  [
    "WLANMCS",
    "33"
  ],
  [
    "WLAN_WDS_Active",
    "0"
  ],
  [
    "WLAN_FltActive",
    "0"
  ],
  [
    "WLAN_FltAction",
    "1"
  ],
  [
    "TxStream_Action",
    "2"
  ],
  [
    "RxStream_Action",
    "2"
  ],
  [
    "CountryChange",
    "0"
  ]
]);

async function loginDefaultAndChangePassword(newPassword) {
  log("1/5 — Đăng nhập modem bằng tài khoản mặc định admin/admin");
  cookies = {};
  // HAR thực tế mở trang gốc trước: GET / trả 401 + JavaScript chuyển sang login.asp.
  // Bỏ qua bước bootstrap này khiến một số G040H trả 401 ở index.asp dù POST login trả 200.
  const root = await modemRequest("GET", "/");
  log(`Bootstrap GET / hoàn tất (HTTP ${root.status}; 401 ở bước này là phản hồi chuyển sang trang đăng nhập theo HAR)`);
  const loginPage = await modemRequest("GET", "/cgi-bin/login.asp", "", {
    "Referer": `https://${activeIp}/`
  });
  log(`Đã nhận trang login.asp (HTTP ${loginPage.status}; ${String(loginPage.text || "").length} ký tự)`);
  if (loginPage.status >= 400) throw new Error(`Mở login.asp thất bại: HTTP ${loginPage.status}`);
  setLoginBase64Cookie("admin", "admin");
  log("Đã tạo cookie base64 sau khi tải login.asp; chuẩn bị POST đăng nhập mặc định");
  let r = await postPage("/cgi-bin/login.asp", {
    StatusActionFlag: "",
    Auth_LoginID: "admin",
    Auth_Password: "admin"
  });
  if (r.status >= 400) throw new Error(`Đăng nhập mặc định thất bại: HTTP ${r.status}`);

  // HAR: sau POST login.asp, trình duyệt GET index.asp với Referer vẫn là login.asp.
  const firstIndex = await modemRequest("GET", "/cgi-bin/index.asp", "", {
    "Referer": `https://${activeIp}/cgi-bin/login.asp`,
    "Origin": `https://${activeIp}`
  });
  if (firstIndex.status >= 400) throw new Error(`Không vào được trang modem: HTTP ${firstIndex.status}`);
  if (!/changeFirstPass\.asp/i.test(firstIndex.text)) {
    throw new Error("Modem không chuyển đến trang đổi mật khẩu lần đầu. Hãy xác nhận modem đang ở trạng thái mặc định.");
  }

  log("Đăng nhập mặc định OK — modem yêu cầu đổi mật khẩu lần đầu");
  // HAR: changeFirstPass.asp được mở từ index.asp.
  const changeHtmlResponse = await modemRequest("GET", "/cgi-bin/changeFirstPass.asp", "", {
    "Referer": `https://${activeIp}/cgi-bin/index.asp`,
    "Origin": `https://${activeIp}`
  });
  if (changeHtmlResponse.status >= 400) throw new Error(`Mở trang đổi mật khẩu thất bại: HTTP ${changeHtmlResponse.status}`);
  const changeHtml = changeHtmlResponse.text;
  const csrf = csrfFrom(changeHtml);
  if (!csrf) throw new Error("Không lấy được CsrfToken tại changeFirstPass.asp");

  r = await postPage("/cgi-bin/changeFirstPass.asp", {
    submitFlag: "1",
    newpass: newPassword,
    confirmnew: newPassword,
    CsrfToken: csrf
  });
  if (r.status >= 400) throw new Error(`Đổi mật khẩu modem thất bại: HTTP ${r.status}`);
  log("Đã gửi yêu cầu đổi mật khẩu quản trị");

  log("Đăng nhập lại bằng mật khẩu mới");
  // Không xóa toàn bộ cookies ở đây: SESSIONID được modem cấp từ GET / đầu tiên.
  // GET login.asp không cấp SESSIONID mới (theo log thực tế), nên xóa cookies
  // khiến POST login chỉ còn base64 và modem trả 401 ở index.asp.
  const sessionBeforeRelogin = cookies.SESSIONID;
  delete cookies.base64;
  delete cookies.md5;
  if (!sessionBeforeRelogin) {
    log("CẢNH BÁO: Không còn SESSIONID trước lần đăng nhập lại; thực hiện bootstrap GET / để xin phiên mới");
    await modemRequest("GET", "/");
  }
  let reloginPage = await modemRequest("GET", "/cgi-bin/login.asp", "", {
    "Referer": `https://${activeIp}/cgi-bin/changeFirstPass.asp`
  });
  // Sau khi đổi mật khẩu, một số firmware hủy SESSIONID cũ.
  // Phản hồi 401 ở lần GET đầu có thể đồng thời cấp SESSIONID mới;
  // thử tải lại login.asp đúng một lần bằng cookie mới đó.
  if (reloginPage.status === 401 && cookies.SESSIONID) {
    log("Modem đã cấp SESSIONID mới sau khi hủy phiên cũ; tải lại login.asp lần 2");
    reloginPage = await modemRequest("GET", "/cgi-bin/login.asp", "", {
      "Referer": `https://${activeIp}/`
    });
  }
  if (reloginPage.status >= 400) throw new Error(`Mở login.asp khi đăng nhập lại thất bại: HTTP ${reloginPage.status}`);
  if (!cookies.SESSIONID) {
    log("CẢNH BÁO: GET login.asp không trả SESSIONID; kiểm tra cookie bootstrap");
  }
  setLoginBase64Cookie("admin", newPassword);
  log(`Đã tạo cookie base64 cho lần đăng nhập mới; cookie gửi đi: ${Object.keys(cookies).join(",") || "(trống)"}`);
  r = await postPage("/cgi-bin/login.asp", {
    StatusActionFlag: "",
    Auth_LoginID: "admin",
    Auth_Password: newPassword
  });
  if (r.status >= 400) throw new Error(`Đăng nhập lại thất bại: HTTP ${r.status}`);

  const index = await modemRequest("GET", "/cgi-bin/index.asp", "", {
    "Referer": `https://${activeIp}/cgi-bin/login.asp`,
    "Origin": `https://${activeIp}`
  });
  if (index.status >= 400 || isLoginPage(index.text)) {
    throw new Error("Đăng nhập lại không thành công. Kiểm tra mật khẩu mới hoặc trạng thái modem.");
  }
  if (!cookies.md5) {
    throw new Error("Không lấy được cookie md5 từ index.asp. Không thể xác thực các API tiếp theo.");
  }
  log("Đăng nhập lại thành công — đã nhận cookie xác thực modem");
}
async function ensureSession(newPassword) {
  let r;
  try {
    r = await modemRequest("GET", "/cgi-bin/index.asp", "", pageHeaders("/cgi-bin/index.asp"));
  } catch (_) {
    r = { status: 0, text: "" };
  }
  if (r.status >= 400 || isLoginPage(r.text) || !cookies.md5) {
    log("Phiên đăng nhập đã hết hoặc modem vừa khởi động lại — đăng nhập lại");
    cookies = {};
    await modemRequest("GET", "/cgi-bin/login.asp");
    setLoginBase64Cookie("admin", newPassword);
    log("Đã tạo cookie base64 cho phiên đăng nhập lại");
    const login = await postPage("/cgi-bin/login.asp", {
      StatusActionFlag: "",
      Auth_LoginID: "admin",
      Auth_Password: newPassword
    });
    if (login.status >= 400) throw new Error(`Đăng nhập lại sau khởi động thất bại: HTTP ${login.status}`);
    const idx = await modemRequest("GET", "/cgi-bin/index.asp", "", {
      "Referer": `https://${activeIp}/cgi-bin/login.asp`,
      "Origin": `https://${activeIp}`
    });
    if (idx.status >= 400 || isLoginPage(idx.text) || !cookies.md5) {
      throw new Error("Không khôi phục được phiên đăng nhập modem");
    }
    log("Đăng nhập lại thành công");
  }
}

async function loginWithCurrentPassword(password) {
  log("1/5 — Đăng nhập modem bằng mật khẩu hiện tại");
  cookies = {};
  const root = await modemRequest("GET", "/");
  log(`Bootstrap GET / hoàn tất (HTTP ${root.status})`);
  const loginPage = await modemRequest("GET", "/cgi-bin/login.asp", "", {
    "Referer": `https://${activeIp}/`
  });
  if (loginPage.status >= 400) throw new Error(`Mở login.asp thất bại: HTTP ${loginPage.status}`);
  setLoginBase64Cookie("admin", password);
  const login = await postPage("/cgi-bin/login.asp", {
    StatusActionFlag: "",
    Auth_LoginID: "admin",
    Auth_Password: password
  });
  if (login.status >= 400) throw new Error(`Đăng nhập bằng mật khẩu hiện tại thất bại: HTTP ${login.status}`);
  const index = await modemRequest("GET", "/cgi-bin/index.asp", "", {
    "Referer": `https://${activeIp}/cgi-bin/login.asp`,
    "Origin": `https://${activeIp}`
  });
  if (index.status >= 400 || isLoginPage(index.text)) {
    throw new Error("Đăng nhập thất bại. Kiểm tra mật khẩu hiện tại của modem.");
  }
  if (!cookies.md5) throw new Error("Không lấy được cookie md5 từ index.asp; không thể xác thực API tiếp theo.");
  log("Đăng nhập bằng mật khẩu hiện tại thành công");
}

async function configureSlid(slid) {
  log("2/5 — Đang cấu hình SLID");
  const path = "/cgi-bin/access_auth.asp";
  const html = await getPage(path);
  const csrf = csrfFrom(html);
  if (!csrf) throw new Error("Không lấy được CsrfToken của trang SLID");
  const inpPassword = inputValue(html, "inpPassword") ?? "Password";
  const r = await postPage(path, {
    SLID_set: slid,
    SLIDflag: "1",
    inpPassword,
    CsrfToken: csrf
  });
  if (r.status >= 400) throw new Error(`Lưu SLID thất bại: HTTP ${r.status}`);
  log(`Đã gửi lệnh lưu SLID (HTTP ${r.status})`);
}

async function configurePppoe(user, pass, vlan) {
  log("3/5 — Tạo PPPoE mới");
  const path = "/cgi-bin/home_wan.asp";
  const createHtml = await getPage(path);
  const existingEntries = wanEntriesFromHtml(createHtml);
  if (existingEntries === null) throw new Error("Không đọc được danh sách WAN; bỏ qua tạo PPPoE để tránh tạo trùng.");
  const existing = existingEntries.find(item => item.created === "Yes" && item.isp === "2" && String(item.vlan) === String(vlan || "11"));
  if (existing) {
    log(`PPPoE VLAN ${vlan || "11"} đã tồn tại; giữ nguyên, bỏ qua tạo mới.`);
    return false;
  }
  const createCsrf = csrfFrom(createHtml);
  if (!createCsrf) throw new Error("Không lấy được CsrfToken trước khi tạo PPPoE");
  const payload = { ...WAN_TEMPLATE };
  payload.wan_PPPUsername = user;
  payload.wan_PPPPassword = pass;
  payload.wan_vid = String(vlan || "11");
  payload.CsrfToken = createCsrf;
  const r = await postPage(path, payload);
  if (r.status >= 400) throw new Error(`Lưu PPPoE thất bại: HTTP ${r.status}`);
  log(`Modem đã phản hồi lệnh tạo PPPoE VLAN ${payload.wan_vid} (HTTP ${r.status}); không tải lại danh sách WAN.`);
  return true;
}

async function prepareWifiBand(band, path, template, ssid, password) {
  log(`Wi-Fi ${band}: GET trang để lấy CSRF`);
  const html = await getPage(path);
  const csrf = csrfFrom(html);
  if (!csrf) throw new Error(`Không lấy được CsrfToken Wi-Fi ${band}`);
  const payload = { ...template };
  payload.ESSID = ssid;
  payload.PreSharedKey1 = inputValue(html, "PreSharedKey1") ?? "1234567890";
  payload.PreSharedKey2 = inputValue(html, "PreSharedKey2") ?? "1234567890";
  payload.PreSharedKey3 = password;
  if (Object.prototype.hasOwnProperty.call(payload, "WDS_Key")) payload.WDS_Key = inputValue(html, "WDS_Key") ?? "12345678";
  payload.CsrfToken = csrf;
  return { band, path, payload };
}
async function saveWifiBand(prepared) {
  const r = await postPage(prepared.path, prepared.payload);
  if (r.status >= 400) throw new Error(`Lưu Wi-Fi ${prepared.band} thất bại: HTTP ${r.status}`);
  log(`Modem đã phản hồi lệnh lưu Wi-Fi ${prepared.band} (HTTP ${r.status})`);
}
async function configureModem(cfg) {
  const warnings = [];
  activeIp = cfg.ip;
  lastResult = null;
  stepLog("Bắt đầu cấu hình modem");
  stepLog(cfg.loginMode === "1" ? "1/4 Login: GET / và login.asp → POST đăng nhập → GET/POST đổi mật khẩu → đăng nhập lại" : "1/4 Login: GET / và login.asp → POST xác thực mật khẩu hiện tại");
  await timedStep("Login", async () => {
    if (cfg.loginMode === "1") await loginDefaultAndChangePassword(cfg.password);
    else await loginWithCurrentPassword(cfg.password);
  });
  stepLog("1/4 Đăng nhập modem: xong");
  await sleep(1000);

  if (cfg.doSlid) { stepLog("2/4 SLID: GET CSRF rồi POST cấu hình"); await timedStep("SLID", () => configureSlid(cfg.slid)); stepLog("2/4 SLID: xong"); }
  else stepLog("2/4 SLID: bỏ qua");
  await sleep(1000);

  if (cfg.doPppoe) {
    try {
      stepLog("3/4 PPPoE: GET danh sách WAN/CSRF rồi POST tạo mới");
      const created = await timedStep("PPPoE", () => configurePppoe(cfg.pppoeUser, cfg.pppoePassword, cfg.vlan));
      stepLog(created ? "3/4 PPPoE: xong" : `3/4 PPPoE: VLAN ${cfg.vlan || "11"} đã có, giữ nguyên`);
    } catch (err) {
      const warning = `PPPoE không hoàn tất: ${err.message || err}`;
      warnings.push(warning);
      stepLog(`⚠️ ${warning}`);
      stepLog("Bỏ qua lỗi PPPoE và tiếp tục các bước còn lại.");
    }
  } else stepLog("3/4 PPPoE: bỏ qua");
  await sleep(1000);
  
  if (cfg.doWifi5g || cfg.doWifi) {
    stepLog("4/4 Wi-Fi 5 GHz: lấy CSRF rồi POST cấu hình");
    try {
      await timedStep("Wi-Fi 5 GHz", async () => {
        const wifi5 = await prepareWifiBand("5G", "/cgi-bin/home_wireless_5g.asp", WIFI5_TEMPLATE, cfg.wifi5gName, cfg.wifi5gPassword);
        await saveWifiBand(wifi5);
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
        const wifi2 = await prepareWifiBand("2.4G", "/cgi-bin/home_wireless.asp", WIFI2_TEMPLATE, cfg.wifi2gName, cfg.wifi2gPassword);
        await saveWifiBand(wifi2);
      });
      stepLog("4/4 Wi-Fi 2.4 GHz: đã nhận phản hồi");
    } catch (err) {
      const warning = `Wi-Fi 2.4 GHz: chưa nhận được xác nhận từ modem (${err.message || err})`;
      warnings.push(warning);
      stepLog(`⚠️ ${warning}`);
    }
  } else stepLog("4/4 Wi-Fi 2.4 GHz: bỏ qua");
  stepLog("Hoàn tất cấu hình");
  return { ok: true, ip: cfg.ip, warnings };
}

function queryBool(v) {
  return ["1", "true", "yes", "on"].includes(String(v || "").toLowerCase());
}
function configFromQuery(p) {
  return {
    ip: p.get("ip") || "192.168.1.1",
    loginMode: p.get("loginMode") || "1",
    password: p.get("password") || "",
    doSlid: queryBool(p.get("doSlid")),
    slid: p.get("slid") || "",
    doPppoe: queryBool(p.get("doPppoe")),
    pppoeUser: p.get("pppoeUser") || "",
    pppoePassword: p.get("pppoePassword") || "",
    vlan: p.get("vlan") || "11",
    doWifi: queryBool(p.get("doWifi")),
    doWifi5g: queryBool(p.get("doWifi5g")) || queryBool(p.get("doWifi")),
    doWifi2g: queryBool(p.get("doWifi2g")) || queryBool(p.get("doWifi")),
    wifi2gName: p.get("wifi2gName") || "",
    wifi2gPassword: p.get("wifi2gPassword") || "",
    wifi5gName: p.get("wifi5gName") || "",
    wifi5gPassword: p.get("wifi5gPassword") || ""
  };
}
function validateConfig(c) {
  if (net.isIP(c.ip) !== 4) throw new Error("Tham số ip phải là địa chỉ IPv4, ví dụ 192.168.1.1");
  if (!['1', '2'].includes(c.loginMode)) throw new Error("loginMode chỉ nhận 1 hoặc 2");
  if (!c.password) throw new Error("Thiếu password (mật khẩu quản trị mới muốn đặt)");
  if (c.doSlid && !c.slid) throw new Error("Đã bật doSlid=1 nhưng chưa có slid");
  if (c.doPppoe && (!c.pppoeUser || !c.pppoePassword)) throw new Error("doPppoe=1 cần pppoeUser và pppoePassword");
  const doWifi5g = c.doWifi5g || c.doWifi;
  const doWifi2g = c.doWifi2g || c.doWifi;
  if (doWifi5g && (!c.wifi5gName || c.wifi5gPassword.length < 8)) throw new Error("Wi-Fi 5 GHz cần tên mạng và mật khẩu ít nhất 8 ký tự");
  if (doWifi2g && (!c.wifi2gName || c.wifi2gPassword.length < 8)) throw new Error("Wi-Fi 2.4 GHz cần tên mạng và mật khẩu ít nhất 8 ký tự");
}
function configurePage() {
  const apiPrefix = G040H_EMBED ? "/g040h" : "";
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cấu hình modem G040H</title>
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
<div class="wrap"><header class="appbar"><button class="back" type="button" aria-label="Về trang chủ" onclick="location.href='index.html'">‹</button><span class="router"><svg viewBox="0 0 48 40" aria-hidden="true"><path d="M8 8h32a5 5 0 0 1 5 5v5H3v-5a5 5 0 0 1 5-5Zm-5 14h42v10a5 5 0 0 1-5 5H8a5 5 0 0 1-5-5V22Zm9 7h5m14 0h5" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M15 8V4m18 4V4" stroke="currentColor" stroke-width="3.5" stroke-linecap="round"/></svg></span><strong>CẤU HÌNH MODEM</strong><button class="menu-home" type="button" aria-label="Về trang chủ" onclick="location.href='index.html'">⋮</button></header><section class="card sync-card"><div class="card-head"><h2><span class="head-icon">⇄</span>LẤY THÔNG TIN THUÊ BAO</h2></div><div class="card-body"><div class="sync-lookup"><div class="field"><label for="subscriberAcc">ACC thuê bao</label><input id="subscriberAcc" type="text" placeholder="Nhập ACC thuê bao" autocomplete="off"></div><button type="button" class="sync-fetch" onclick="window.syncSubscriberData(this)">LẤY THÔNG TIN</button></div><div class="sync-note" id="syncStatus">Nhập ACC rồi chọn LẤY THÔNG TIN để điền dữ liệu vào form.</div></div></section><form id="configForm"><section class="card"><div class="card-head"><h2><span class="head-icon">▣</span>1. ĐĂNG NHẬP MODEM</h2></div><div class="card-body"><div class="grid"><div class="field"><label><span class="ico">▣</span>IP Modem</label><input name="ip" id="ip" value="192.168.1.1" placeholder="192.168.1.1" required></div><div class="field"><label><span class="ico">👤</span>Tài khoản</label><input value="admin" disabled></div><div class="field full"><label><span class="ico">⚙</span>Chế độ đăng nhập</label><select id="loginMode" name="loginMode"><option value="1">1 - Modem vừa reset / admin-admin</option><option value="2">2 - Modem đã đổi mật khẩu</option></select></div><div class="field full"><label id="passwordLabel"><span class="ico">🔑</span>Mật khẩu mới (nếu cần)</label><div class="field-wrap"><input id="password" name="password" type="text" placeholder="Nhập mật khẩu mới cho modem" required></div></div></div></div></section><section class="card"><div class="card-head"><h2><span class="head-icon">♧</span>2. SLID GPON</h2><span class="enable-badge" id="badge-doSlid">Enable</span></div><div class="card-body"><div class="field"><label>SLID GPON</label><input id="slid" name="slid" value="A00012345"></div></div></section><section class="card pppoe-card"><div class="card-head"><h2><span class="head-icon">◎</span>3. WAN - PPPoE</h2><span class="enable-badge" id="badge-doPppoe">Enable</span></div><div class="card-body"><div class="grid"><div class="field"><label><span class="ico">▣</span>Tài khoản PPPoE</label><input id="pppoeUser" name="pppoeUser" value="ppp_user"></div><div class="field"><label><span class="ico">♧</span>VLAN WAN</label><input id="vlan" name="vlan" value="11"></div><div class="field full"><label><span class="ico">🔑</span>Mật khẩu PPPoE</label><div class="field-wrap"><input id="pppoePassword" name="pppoePassword" type="text" value="abcd1234"></div></div></div></div></section><div class="wifi-grid"><section class="card wifi-card band24"><div class="card-head"><h2><span class="head-icon">◉</span>4. WiFi 2.4 GHz</h2><span class="enable-badge" id="badge-doWifi2g">Enable</span></div><div class="card-body"><div class="field"><label><span class="ico">◉</span>Tên WiFi (SSID)</label><input id="wifi2gName" name="wifi2gName" type="text" value="WiFi 2.4G"></div><div class="field" style="margin-top:9px"><label><span class="ico">🔑</span>Mật khẩu WiFi</label><div class="field-wrap"><input id="wifi2gPassword" name="wifi2gPassword" type="text" value="1234567890"></div></div></div></section><section class="card wifi-card band5"><div class="card-head"><h2><span class="head-icon">◉</span>5. WiFi 5 GHz</h2><span class="enable-badge" id="badge-doWifi5g">Enable</span></div><div class="card-body"><div class="field"><label><span class="ico">◉</span>Tên WiFi (SSID)</label><input id="wifi5gName" name="wifi5gName" type="text" value="WiFi 5G"></div><div class="field" style="margin-top:9px"><label><span class="ico">🔑</span>Mật khẩu WiFi</label><div class="field-wrap"><input id="wifi5gPassword" name="wifi5gPassword" type="text" value="1234567890"></div></div></div></section></div><section class="toggle-row"><label class="step-option"><input id="doSlid" name="doSlid" type="checkbox" checked onchange="syncStepBadges()"><span>SLID<br>GPON</span></label><label class="step-option"><input id="doPppoe" name="doPppoe" type="checkbox" checked onchange="syncStepBadges()"><span>WAN<br>PPPoE</span></label><label class="step-option"><input id="doWifi2g" name="doWifi2g" type="checkbox" checked onchange="syncStepBadges()"><span>WiFi<br>2.4 GHz</span></label><label class="step-option"><input id="doWifi5g" name="doWifi5g" type="checkbox" checked onchange="syncStepBadges()"><span>WiFi<br>5 GHz</span></label></section><section class="action-card"><button class="run" type="submit" id="run">▶ &nbsp;BẮT ĐẦU CẤU HÌNH</button><div id="status" class="status">Sẵn sàng.</div></section></form><section class="card log-card"><div class="log-tools" id="logControls"><div class="log-modes"><label class="log-mode"><input type="radio" name="logMode" value="quick" checked> Log</label><label class="log-mode"><input type="radio" name="logMode" value="raw"> Log RAW</label></div><div class="log-actions"><button type="button" id="copyLogs">Copy</button><button type="button" id="clearLogs">Del</button></div></div><pre id="logs" class="log">Chưa có log.</pre></section></div><script>function syncStepBadges(){['doSlid','doPppoe','doWifi2g','doWifi5g'].forEach(function(id){var c=document.getElementById(id),b=document.getElementById('badge-'+id);if(c&&b){b.textContent=c.checked?'Enable':'Disable';b.classList.toggle('off',!c.checked)}})}function toggleField(id,b){var e=document.getElementById(id);if(!e)return;e.type=e.type==='password'?'text':'password';b.textContent=e.type==='password'?'◉':'◎';}syncStepBadges();</script>
<script>(function(){const mode=document.getElementById("loginMode"),label=document.getElementById("passwordLabel"),password=document.getElementById("password");function updatePasswordLabel(){const first=mode.value==="1";label.textContent=first?"Mật khẩu mới":"Mật khẩu hiện tại";password.placeholder=first?"Nhập mật khẩu mới cho modem":"Nhập mật khẩu hiện tại của modem";password.autocomplete=first?"new-password":"current-password";}mode.addEventListener("change",updatePasswordLabel);updatePasswordLabel();})();</script><script>(function(){"use strict";const prefix=${JSON.stringify(apiPrefix)},form=document.getElementById("configForm"),logs=document.getElementById("logs"),status=document.getElementById("status"),run=document.getElementById("run");async function refresh(){try{const r=await fetch(prefix+"/api/status",{cache:"no-store"});const d=await r.json();const shown=document.querySelector("input[name=logMode]:checked").value==="raw"?d.rawLogs:d.logs;logs.textContent=shown&&shown.length?shown.join("\\n"):"Chưa có log.";logs.scrollTop=logs.scrollHeight;status.textContent=d.busy?"⏳ ĐANG CẤU HÌNH MODEM...":(d.result&&d.result.ok===false?"❌ Cấu hình có lỗi.":(d.result&&d.result.warnings&&d.result.warnings.length?"⚠️ Hoàn tất nhưng có bước bị bỏ qua.":(d.result?"✅ Cấu hình hoàn tất.":"Sẵn sàng.")));status.className="status"+(d.busy?" running":(d.result&&d.result.ok===false?" err":""));run.disabled=!!d.busy;}catch(e){status.textContent="Không kết nối được API: "+e.message;status.className="status err";}}form.addEventListener("submit",async function(e){e.preventDefault();const body=new URLSearchParams(new FormData(form));status.textContent="Đang gửi yêu cầu cấu hình...";status.className="status running";try{const r=await fetch(prefix+"/api/configure",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded;charset=UTF-8"},body:body.toString()});const d=await r.json();if(!r.ok||!d.ok)throw new Error(d.error||"Không thể bắt đầu");await refresh();}catch(err){status.textContent="Lỗi: "+err.message;status.className="status err";}});document.querySelectorAll("input[name=logMode]").forEach(el=>el.addEventListener("change",refresh));document.getElementById("copyLogs").addEventListener("click",async()=>{const t=logs.textContent;try{await navigator.clipboard.writeText(t)}catch(e){const x=document.createElement("textarea");x.value=t;document.body.appendChild(x);x.select();document.execCommand("copy");x.remove()}});document.getElementById("clearLogs").addEventListener("click",async()=>{await fetch(prefix+"/api/logs",{method:"DELETE"});refresh()});fetch(prefix+"/api/logs",{method:"DELETE",cache:"no-store"}).then(refresh).catch(refresh);setInterval(refresh,1000);})();</script></body></html>`;
}
function configureLogPage() {
  const apiPrefix = G040H_EMBED ? "/g040h" : "";
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nhật ký cấu hình G040H</title>
<style>*{box-sizing:border-box}body{margin:0;background:#101418;color:#eef2f6;font:16px Arial,sans-serif}main{max-width:850px;margin:24px auto;padding:12px}.log-tools{display:flex;flex-direction:column;gap:8px;margin:8px 0 12px}.log-modes,.log-actions{display:flex;align-items:center;gap:12px}.log-mode{display:flex!important;align-items:center;gap:8px;margin:0!important;font-size:18px;white-space:nowrap}.log-mode input[type=radio]{width:24px!important;height:24px;margin:0;flex:none}.log-actions{width:100%}.log-actions button{width:50%!important;flex:1;margin:0;padding:12px 8px;font-size:18px}.log-actions button{background:#3478f6;color:#fff;border:0;border-radius:9px;font-weight:bold}.card{background:#1b222a;border:1px solid #35404c;border-radius:14px;padding:18px}h2{margin:0 0 8px;font-size:22px}.muted{color:#aab6c2;font-size:13px}.status{margin:14px 0;padding:12px;border-radius:9px;background:#111820;color:#ffd166;font-weight:bold}pre{margin:0;height:65vh;min-height:300px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;background:#080c10;border-radius:9px;padding:14px;color:#d8e4ef;font:13px/1.55 Consolas,monospace}@media(max-width:600px){main{margin:0;padding:8px}.card{padding:12px}pre{height:72vh}}#status{display:none!important}


/* Separate subscriber lookup, stacked Wi-Fi bands, and taller logs */
.sync-lookup{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:end}
.sync-fetch{width:auto!important;min-width:180px;height:46px;margin:0!important;padding:8px 18px!important;border:0;border-radius:11px!important;background:#0877e8!important;color:#fff!important;font-size:16px!important;font-weight:800}
.sync-card .sync-note{margin-top:9px;font-size:14px;line-height:1.35}
.sync-card{border-color:#0877e8}
.wifi-grid{grid-template-columns:minmax(0,1fr)!important;gap:10px!important}
.log{height:320px!important;min-height:38vh!important}
@media(max-width:520px){.sync-lookup{grid-template-columns:minmax(0,1fr)}.sync-fetch{width:100%!important}.log{height:280px!important;min-height:34vh!important}}
</style></head><body><main><section class="card"><h2>📋 CẤU HÌNH MODEM G040H</h2><div class="muted">Đang theo dõi nhật ký cấu hình. Giữ trang mở trong khi modem đang chạy.</div><div id="status" class="status">Đang kết nối...</div><div class="log-tools" id="logControls"><div class="log-modes"><label class="log-mode"><input type="radio" name="logMode" value="quick" checked> Log</label><label class="log-mode"><input type="radio" name="logMode" value="raw"> Log RAW</label></div><div class="log-actions"><button type="button" id="copyLogs">Copy</button><button type="button" id="clearLogs">Del</button></div></div><pre id="logs">Đang chờ nhật ký...</pre></section></main>
<script>(function(){try{history.replaceState(null,"",location.pathname+"?view=1")}catch(e){}const prefix=${JSON.stringify(apiPrefix)},status=document.getElementById("status"),logs=document.getElementById("logs");async function refresh(){try{const r=await fetch(prefix+"/api/status",{cache:"no-store"});const d=await r.json();const shown=document.querySelector("input[name=logMode]:checked").value==="raw"?d.rawLogs:d.logs;logs.textContent=shown&&shown.length?shown.join("\\n"):"Chưa có log.";logs.scrollTop=logs.scrollHeight;status.textContent=d.busy?"⏳ ĐANG CẤU HÌNH MODEM...":(d.result&&d.result.ok===false?"❌ CẤU HÌNH CÓ LỖI":(d.result&&d.result.warnings&&d.result.warnings.length?"⚠️ HOÀN TẤT NHƯNG CÓ BƯỚC BỊ BỎ QUA":(d.result?"✅ CẤU HÌNH HOÀN TẤT":"✅ ĐÃ DỪNG / SẴN SÀNG")));}catch(e){status.textContent="Mất kết nối nhật ký: "+e.message}}document.querySelectorAll("input[name=logMode]").forEach(x=>x.addEventListener("change",refresh));document.getElementById("copyLogs").addEventListener("click",async()=>{const t=logs.textContent;try{await navigator.clipboard.writeText(t)}catch(e){const x=document.createElement("textarea");x.value=t;document.body.appendChild(x);x.select();document.execCommand("copy");x.remove()}});document.getElementById("clearLogs").addEventListener("click",async()=>{await fetch(prefix+"/api/logs",{method:"DELETE"});refresh()});refresh();setInterval(refresh,1000)})();</script></body></html>`;
}
function send(res, status, type, body) {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}
function sendJson(res, status, data) { send(res, status, "application/json; charset=utf-8", JSON.stringify(data)); }
function startFromUrl(res, url) {
  if (busy) return send(res, 200, "text/html; charset=utf-8", configureLogPage());
  const cfg = configFromQuery(url.searchParams);
  try { validateConfig(cfg); }
  catch (e) {
    log("LỖI THAM SỐ: " + e.message);
    return send(res, 200, "text/html; charset=utf-8", configureLogPage());
  }
  busy = true;
  logs = [];
  lastResult = null;
  configureModem(cfg)
    .then(result => { lastResult = result; })
    .catch(err => {
      lastResult = { ok: false, error: err.message || String(err) };
      log("LỖI: " + lastResult.error);
    })
    .finally(() => { busy = false; });
  return send(res, 200, "text/html; charset=utf-8", configureLogPage());
}
async function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", c => { data += c; if (data.length > 1024 * 1024) reject(new Error("Body quá lớn")); });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
    const path = url.pathname;
    if (req.method === "GET" && path.endsWith("/configure")) {
      if (url.searchParams.get("view") === "1") return send(res, 200, "text/html; charset=utf-8", configureLogPage());
      return startFromUrl(res, url);
    }
    if (req.method === "GET" && (path === "/" || path.endsWith("/"))) {
      return send(res, 200, "text/html; charset=utf-8", configurePage());
    }
    if (req.method === "POST" && path.endsWith("/api/client-log")) { const data=JSON.parse(await readBody(req)||"{}"); const stamp=`[${new Date().toLocaleTimeString("vi-VN",{hour12:false})}]\n`; if(data.quick)logs.push(stamp+String(data.quick)); if(data.raw)rawLogs.push(stamp+String(data.raw)); logs=logs.slice(-MAX_LOGS); rawLogs=rawLogs.slice(-MAX_LOGS); return sendJson(res,200,{ok:true}); }
    if (req.method === "GET" && path.endsWith("/api/status")) {
      const stepLogs = logs.filter(line => !/\[HTTP(?:>|<|!)/.test(line));
      return sendJson(res, 200, { ok: true, busy, logs: stepLogs, rawLogs, result: lastResult });
    }
    if (req.method === "DELETE" && path.endsWith("/api/logs")) {
      logs = []; rawLogs = []; lastResult = null;
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === "POST" && path.endsWith("/api/configure")) {
      if (busy) return sendJson(res, 409, { ok: false, error: "Đang có phiên cấu hình khác chạy" });
      const body = await readBody(req);
      const p = new URLSearchParams(body);
      const cfg = configFromQuery(p);
      try { validateConfig(cfg); }
      catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
      busy = true; logs = []; rawLogs = []; lastResult = null;
      configureModem(cfg).then(r => { lastResult = r; })
        .catch(e => { lastResult = { ok: false, error: e.message }; log("LỖI: " + e.message); })
        .finally(() => { busy = false; });
      return sendJson(res, 202, { ok: true, message: "Đã bắt đầu cấu hình" });
    }
    return send(res, 404, "text/plain; charset=utf-8", "Not Found");
  } catch (e) {
    return sendJson(res, 500, { ok: false, error: e.message || String(e) });
  }
});
if (!G040H_EMBED) {
  server.listen(PORT, HOST, () => {
    console.log(`[G040H] Listening on http://${HOST}:${PORT}`);
  });
}
server.on("error", err => console.error("[G040H] Server error:", err));
process.on("uncaughtException", err => console.error("[G040H] Uncaught:", err));

module.exports = { server };


