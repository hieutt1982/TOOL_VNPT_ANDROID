package com.vnpt.tool;

import android.webkit.WebView;
import android.os.Handler;
import android.os.Looper;
import java.io.IOException;
import java.util.Iterator;
import java.util.Locale;
import java.io.FileOutputStream;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.TimeZone;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import okhttp3.*;
import okio.Buffer;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

public final class WebBridge {
    private final WebView web;
    private final ExecutorService pool = Executors.newFixedThreadPool(4);
    private final Handler main = new Handler(Looper.getMainLooper());
    private static final String UPSTREAM = "https://api-onebss.vnpt.vn";
    private static final String MODEM_KEY = "FVcLoGQybQAkTn3qR1WcEVAiLCOHxwEp";

    public WebBridge(WebView w) { web = w; }

    @JavascriptInterface public void request(String id, String method, String url, String headersJson, String body, boolean modem) {
        pool.execute(() -> {
            JSONObject out = new JSONObject();
            try {
                HttpUrl u = HttpUrl.parse(url);
                if (u == null || !"https".equalsIgnoreCase(u.scheme())) throw new IOException("Chỉ cho phép HTTPS");
                if (modem && !ApiClient.isPrivateModemHost(u.host())) throw new IOException("SSL bỏ qua chỉ áp dụng cho IP modem nội bộ/private");
                if (!modem && !allowedHost(u.host())) throw new IOException("Host chưa được cho phép: " + u.host());
                JSONObject h = new JSONObject(headersJson == null ? "{}" : headersJson);
                Request.Builder b = new Request.Builder().url(u);
                Iterator<String> it = h.keys(); while (it.hasNext()) { String k = it.next(); b.header(k, h.optString(k)); }
                String m = method == null ? "GET" : method.toUpperCase(Locale.US);
                RequestBody rb = null;
                if (!m.equals("GET") && !m.equals("HEAD")) rb = RequestBody.create(body == null ? "" : body, MediaType.parse(h.optString("Content-Type", "application/json; charset=utf-8")));
                b.method(m, rb);
                try (Response r = (modem ? ApiClient.modem() : ApiClient.normal()).newCall(b.build()).execute()) {
                    String responseText = "";
                    boolean aborted = false;
                    if (r.body() != null) {
                        Buffer buffer = new Buffer();
                        try {
                            while (r.body().source().read(buffer, 8192) != -1) { }
                        } catch (IOException partialRead) {
                            aborted = true;
                        }
                        responseText = buffer.readString(StandardCharsets.UTF_8);
                    }
                    out.put("ok", true); out.put("status", r.code()); out.put("text", responseText); out.put("aborted", aborted);
                    JSONObject rh = new JSONObject(); for (String n : r.headers().names()) { java.util.List<String> vals = r.headers().values(n); if (vals.size() > 1 || n.equalsIgnoreCase("set-cookie")) rh.put(n.toLowerCase(Locale.US), new org.json.JSONArray(vals)); else rh.put(n.toLowerCase(Locale.US), vals.isEmpty() ? "" : vals.get(0)); } out.put("headers", rh);
                }
            } catch (Exception e) { try { out.put("ok", false); out.put("error", e.getMessage() == null ? e.toString() : e.getMessage()); } catch (Exception ignored) {} }
            deliver(id, out);
        });
    }

    /** Native replacement for the Node.js OneLink proxy routes. */
    @JavascriptInterface public void requestOneLink(String id, String method, String path, String headersJson, String body) {
        pool.execute(() -> {
            JSONObject out = new JSONObject();
            try {
                String m = method == null ? "GET" : method.toUpperCase(Locale.US);
                HttpUrl incoming = HttpUrl.parse("https://local.invalid" + (path.startsWith("/") ? path : "/" + path));
                if (incoming == null) throw new IOException("Đường dẫn API không hợp lệ");
                String p = incoming.encodedPath();
                if (p.equals("/api/log-login") && m.equals("POST")) {
                    JSONObject audit = new JSONObject(body == null || body.isEmpty() ? "{}" : body);
                    JSONObject line = new JSONObject();
                    SimpleDateFormat iso = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
                    iso.setTimeZone(TimeZone.getTimeZone("UTC"));
                    line.put("time", iso.format(new Date()));
                    line.put("app", audit.optString("app", "MODEM"));
                    line.put("username", audit.optString("username", ""));
                    try (FileOutputStream fos = web.getContext().openFileOutput("login_log.jsonl", android.content.Context.MODE_APPEND)) {
                        fos.write((line.toString() + "\n").getBytes(java.nio.charset.StandardCharsets.UTF_8));
                    }
                    out.put("ok", true); out.put("status", 200); out.put("text", "{\"ok\":true}");
                    deliver(id, out); return;
                }
                String target;
                Request.Builder req;
                JSONObject h = new JSONObject(headersJson == null ? "{}" : headersJson);
                if (p.equals("/api/auth/step1") && m.equals("POST")) {
                    target = "/quantri/user/xacthuc_tapdoan_v2";
                    req = new Request.Builder().url(UPSTREAM + target).header("Accept", "application/json").header("User-Agent", "Dart/3.10 (dart:io)");
                    addBody(req, body, h);
                } else if (p.equals("/api/auth/step2") && m.equals("POST")) {
                    target = "/quantri/oauth/token";
                    req = new Request.Builder().url(UPSTREAM + target).header("Accept", "application/json").header("User-Agent", "Dart/3.10 (dart:io)");
                    addBody(req, body, h);
                } else if (p.startsWith("/api/modem/") && m.equals("GET")) {
                    target = "/esbx/onelink" + p.substring("/api/modem".length());
                    req = new Request.Builder().url(UPSTREAM + target + (incoming.encodedQuery() == null ? "" : "?" + incoming.encodedQuery()))
                        .header("Accept", "application/json").header("Content-Type", "application/json")
                        .header("token-key", MODEM_KEY).header("token-id", "SDK_TECH").get();
                } else if (p.equals("/api/modem/deviceConfig") && m.equals("POST")) {
                    req = new Request.Builder().url(UPSTREAM + "/esbx/onelink/deviceConfig")
                        .header("Accept", "application/json").header("Content-Type", "application/json")
                        .header("token-key", MODEM_KEY).header("token-id", "SDK_TECH");
                    addBody(req, body, h);
                } else if (p.equals("/api/thicong/dsVatTuThiCong") && m.equals("POST")) {
                    String query = incoming.encodedQuery() == null ? "" : "?" + incoming.encodedQuery();
                    req = new Request.Builder().url(UPSTREAM + "/app-thicong/thiCong/traCuuThiCong/dsVatTuThiCong" + query)
                        .header("Accept", "application/json").header("Content-Type", "application/json")
                        .header("Authorization", h.optString("authorization", ""))
                        .header("selectedmenuid", h.optString("selectedmenuid", "11226"))
                        .header("app-secret", h.optString("app-secret", ""));
                    addBody(req, body, h);
                } else throw new IOException("API OneLink chưa được hỗ trợ: " + m + " " + p);

                try (Response r = ApiClient.normal().newCall(req.build()).execute()) {
                    String text = r.body() == null ? "" : r.body().string();
                    out.put("ok", true); out.put("status", r.code()); out.put("text", text);
                    JSONObject rh = new JSONObject(); for (String n : r.headers().names()) { java.util.List<String> vals = r.headers().values(n); if (vals.size() > 1 || n.equalsIgnoreCase("set-cookie")) rh.put(n.toLowerCase(Locale.US), new org.json.JSONArray(vals)); else rh.put(n.toLowerCase(Locale.US), vals.isEmpty() ? "" : vals.get(0)); } out.put("headers", rh);
                }
            } catch (Exception e) { try { out.put("ok", false); out.put("error", e.getMessage() == null ? e.toString() : e.getMessage()); } catch (Exception ignored) {} }
            deliver(id, out);
        });
    }

    private void addBody(Request.Builder req, String body, JSONObject headers) {
        String ct = headers.optString("Content-Type", headers.optString("content-type", "application/json; charset=utf-8"));
        req.header("Content-Type", ct);
        req.method("POST", RequestBody.create(body == null ? "" : body, MediaType.parse(ct)));
    }
    private void deliver(String id, JSONObject out) {
        String raw = out.toString();
        main.post(() -> web.evaluateJavascript("window.__nativeHttpDone(" + JSONObject.quote(id) + "," + JSONObject.quote(raw) + ")", null));
    }
    private boolean allowedHost(String h) { return h.equalsIgnoreCase("api-onebss.vnpt.vn") || h.endsWith(".vnpt.vn") || h.equalsIgnoreCase("vnpt.vn"); }
    public void close() { pool.shutdownNow(); }
    @JavascriptInterface public String version() { return "TOOL_VNPT_ANDROID/1.1.0"; }
}
