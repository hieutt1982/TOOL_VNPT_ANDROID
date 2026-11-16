package com.vnpt.tool;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.FileOutputStream;
import java.io.FileInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Iterator;
import java.util.Locale;
import java.util.TimeZone;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import okhttp3.HttpUrl;
import okhttp3.MediaType;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

/**
 * JavaScript bridge used by the WebView.
 * Public VNPT APIs always use normal TLS validation. The modem client is only
 * selected for private/local modem IP addresses, where self-signed TLS is common.
 */
public final class WebBridge {
    private static final String UPSTREAM = "https://api-onebss.vnpt.vn";
    private static final String MODEM_KEY = "FVcLoGQybQAkTn3qR1WcEVAiLCOHxwEp";

    private final WebView webView;
    private final ExecutorService executor = Executors.newFixedThreadPool(4);
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private static final String DIAG_FILE = "vnpt_diagnostic.log";
    private static final Object LOG_LOCK = new Object();
    private static final int MAX_LOG_CHARS = 900000;

    public WebBridge(WebView webView) {
        this.webView = webView;
        diag("APP", "WebBridge khởi tạo; version=" + version());
    }

    /** Generic HTTPS request bridge. */
    @JavascriptInterface
    public void request(String id, String method, String url, String headersJson,
                        String body, boolean modem) {
        executor.execute(() -> {
            JSONObject result = new JSONObject();
            try {
                HttpUrl parsedUrl = HttpUrl.parse(url == null ? "" : url);
                if (parsedUrl == null || !"https".equalsIgnoreCase(parsedUrl.scheme())) {
                    throw new IOException("Chỉ cho phép HTTPS");
                }

                if (modem) {
                    if (!ApiClient.isPrivateModemHost(parsedUrl.host())) {
                        throw new IOException("Bỏ qua SSL chỉ được phép với IP modem nội bộ");
                    }
                } else if (!isAllowedVnptHost(parsedUrl.host())) {
                    throw new IOException("Host chưa được cho phép: " + parsedUrl.host());
                }

                JSONObject headers = new JSONObject(headersJson == null ? "{}" : headersJson);
                String httpMethod = method == null ? "GET" : method.toUpperCase(Locale.US);
                diag("HTTP>", httpMethod + " " + parsedUrl + " modem=" + modem + " headers=" + safeHeaders(headers) + " body=" + safeBody(body));
                long startedAt = System.currentTimeMillis();
                Request.Builder requestBuilder = new Request.Builder().url(parsedUrl);
                Iterator<String> names = headers.keys();
                while (names.hasNext()) {
                    String name = names.next();
                    requestBuilder.header(name, headers.optString(name, ""));
                }

                if ("GET".equals(httpMethod) || "HEAD".equals(httpMethod)) {
                    requestBuilder.method(httpMethod, null);
                } else {
                    String contentType = headers.optString("Content-Type",
                            headers.optString("content-type", "application/json; charset=utf-8"));
                    MediaType mediaType = MediaType.parse(contentType);
                    RequestBody requestBody = RequestBody.create(body == null ? "" : body, mediaType);
                    requestBuilder.method(httpMethod, requestBody);
                }

                okhttp3.OkHttpClient client = modem ? ApiClient.modem() : ApiClient.normal();
                try (Response response = client.newCall(requestBuilder.build()).execute()) {
                    String responseText = response.body() == null ? "" : response.body().string();
                    result.put("ok", true);
                    result.put("status", response.code());
                    result.put("text", responseText);
                    result.put("headers", headersToJson(response.headers().toMultimap()));
                    diag("HTTP<", httpMethod + " " + parsedUrl.encodedPath() + " => " + response.code() + " in " + (System.currentTimeMillis()-startedAt) + "ms; headers=" + safeResponseHeaders(response.headers().toMultimap()) + "; body=" + safeBody(responseText));
                }
            } catch (Exception error) {
                diag("HTTP!", "request " + url + " failed: " + Log.getStackTraceString(error));
                putError(result, error);
            }
            deliver(id, result);
        });
    }

    @JavascriptInterface
    public void saveOneLinkToken(String tokenJson) {
        webView.getContext().getSharedPreferences("onelink_auth", Context.MODE_PRIVATE)
                .edit().putString("token", tokenJson == null ? "" : tokenJson).apply();
    }

    @JavascriptInterface
    public String getOneLinkToken() {
        return webView.getContext().getSharedPreferences("onelink_auth", Context.MODE_PRIVATE)
                .getString("token", "");
    }

    @JavascriptInterface
    public void clearOneLinkToken() {
        webView.getContext().getSharedPreferences("onelink_auth", Context.MODE_PRIVATE)
                .edit().remove("token").apply();
    }

    /** Native implementation of the OneLink routes previously served by Node.js. */
    @JavascriptInterface
    public void requestOneLink(String id, String method, String path,
                               String headersJson, String body) {
        executor.execute(() -> {
            JSONObject result = new JSONObject();
            String route = "(unknown)"; // Keep available to the catch block for diagnostics.
            try {
                String httpMethod = method == null ? "GET" : method.toUpperCase(Locale.US);
                String safePath = (path == null || path.isEmpty()) ? "/" : path;
                HttpUrl incoming = HttpUrl.parse("https://local.invalid" +
                        (safePath.startsWith("/") ? safePath : "/" + safePath));
                if (incoming == null) throw new IOException("Đường dẫn API không hợp lệ");

                route = incoming.encodedPath();
                JSONObject headers = new JSONObject(headersJson == null ? "{}" : headersJson);
                diag("ONELINK>", httpMethod + " " + route + " headers=" + safeHeaders(headers) + " body=" + safeBody(body));
                long startedAt = System.currentTimeMillis();

                if ("/api/log-login".equals(route) && "POST".equals(httpMethod)) {
                    writeLoginLog(body);
                    result.put("ok", true);
                    result.put("status", 200);
                    result.put("text", "{\"ok\":true}");
                    deliver(id, result);
                    return;
                }

                Request.Builder upstreamRequest;
                if ("/api/auth/step1".equals(route) && "POST".equals(httpMethod)) {
                    upstreamRequest = new Request.Builder()
                            .url(UPSTREAM + "/quantri/user/xacthuc_tapdoan_v2")
                            .header("Accept", "application/json")
                            .header("User-Agent", "Dart/3.10 (dart:io)")
                            ;
                    addPostBody(upstreamRequest, body, headers);
                } else if ("/api/auth/step2".equals(route) && "POST".equals(httpMethod)) {
                    upstreamRequest = new Request.Builder()
                            .url(UPSTREAM + "/quantri/oauth/token")
                            .header("Accept", "application/json")
                            .header("User-Agent", "Dart/3.10 (dart:io)")
                            ;
                    addPostBody(upstreamRequest, body, headers);
                } else if (route.startsWith("/api/modem/") && "GET".equals(httpMethod)) {
                    String targetPath = "/esbx/onelink" + route.substring("/api/modem".length());
                    String query = incoming.encodedQuery() == null ? "" : "?" + incoming.encodedQuery();
                    upstreamRequest = new Request.Builder()
                            .url(UPSTREAM + targetPath + query)
                            .header("Accept", "application/json")
                            .header("Content-Type", "application/json")
                            .header("token-key", MODEM_KEY)
                            .header("token-id", "SDK_TECH")
                            .get();
                } else if ("/api/modem/deviceConfig".equals(route) && "POST".equals(httpMethod)) {
                    upstreamRequest = new Request.Builder()
                            .url(UPSTREAM + "/esbx/onelink/deviceConfig")
                            .header("Accept", "application/json")
                            .header("Content-Type", "application/json")
                            .header("token-key", MODEM_KEY)
                            .header("token-id", "SDK_TECH");
                    addPostBody(upstreamRequest, body, headers);
                } else if ("/api/thicong/dsVatTuThiCong".equals(route) && "POST".equals(httpMethod)) {
                    String query = incoming.encodedQuery() == null ? "" : "?" + incoming.encodedQuery();
                    upstreamRequest = new Request.Builder()
                            .url(UPSTREAM + "/app-thicong/thiCong/traCuuThiCong/dsVatTuThiCong" + query)
                            .header("Accept", "application/json")
                            .header("Content-Type", "application/json")
                            .header("Authorization", headerValue(headers, "authorization"))
                            .header("selectedmenuid", headerValueOr(headers, "selectedmenuid", "11226"))
                            .header("app-secret", headerValue(headers, "app-secret"));
                    addPostBody(upstreamRequest, body, headers);
                } else {
                    throw new IOException("API OneLink chưa được hỗ trợ: " + httpMethod + " " + route);
                }

                try (Response response = ApiClient.oneLink().newCall(upstreamRequest.build()).execute()) {
                    String responseText = response.body() == null ? "" : response.body().string();
                    result.put("ok", true);
                    result.put("status", response.code());
                    result.put("text", responseText);
                    result.put("headers", headersToJson(response.headers().toMultimap()));
                    diag("ONELINK<", route + " => " + response.code() + " in " + (System.currentTimeMillis()-startedAt) + "ms; headers=" + safeResponseHeaders(response.headers().toMultimap()) + "; body=" + safeBody(responseText));
                }
            } catch (Exception error) {
                diag("ONELINK!", route + " failed: " + Log.getStackTraceString(error));
                putError(result, error);
            }
            deliver(id, result);
        });
    }

    private void addPostBody(Request.Builder builder, String body, JSONObject headers) {
        String contentType = headers.optString("Content-Type",
                headers.optString("content-type", "application/json; charset=utf-8"));
        MediaType mediaType = MediaType.parse(contentType);
        RequestBody requestBody = RequestBody.create(body == null ? "" : body, mediaType);
        builder.header("Content-Type", contentType).post(requestBody);
    }

    private void writeLoginLog(String body) throws Exception {
        JSONObject audit = new JSONObject(body == null || body.isEmpty() ? "{}" : body);
        JSONObject line = new JSONObject();
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        line.put("time", format.format(new Date()));
        line.put("app", audit.optString("app", "MODEM"));
        line.put("username", audit.optString("username", ""));

        try (FileOutputStream output = webView.getContext().openFileOutput(
                "login_log.jsonl", Context.MODE_APPEND)) {
            output.write((line.toString() + "\n").getBytes(StandardCharsets.UTF_8));
        }
    }

    private JSONObject headersToJson(java.util.Map<String, java.util.List<String>> headers)
            throws Exception {
        JSONObject json = new JSONObject();
        for (java.util.Map.Entry<String, java.util.List<String>> entry : headers.entrySet()) {
            String name = entry.getKey().toLowerCase(Locale.US);
            java.util.List<String> values = entry.getValue();
            if (values == null || values.isEmpty()) {
                json.put(name, "");
            } else if (values.size() > 1 || "set-cookie".equals(name)) {
                json.put(name, new JSONArray(values));
            } else {
                json.put(name, values.get(0));
            }
        }
        return json;
    }

    private String headerValue(JSONObject headers, String name) {
        return headers.optString(name, headers.optString(name.toLowerCase(Locale.US), ""));
    }

    private String headerValueOr(JSONObject headers, String name, String fallback) {
        String value = headerValue(headers, name);
        return value.isEmpty() ? fallback : value;
    }

    private boolean isAllowedVnptHost(String host) {
        return host != null && (host.equalsIgnoreCase("vnpt.vn") ||
                host.endsWith(".vnpt.vn"));
    }

    private void putError(JSONObject result, Exception error) {
        try {
            result.put("ok", false);
            result.put("error", error.getMessage() == null ? error.toString() : error.getMessage());
        } catch (Exception ignored) {
            // Nothing else can be done if the JSON error object cannot be written.
        }
    }

    private void deliver(String id, JSONObject result) {
        String raw = result.toString();
        mainHandler.post(() -> webView.evaluateJavascript(
                "window.__nativeHttpDone(" + JSONObject.quote(id) + "," +
                        JSONObject.quote(raw) + ")", null));
    }

    @JavascriptInterface
    public String version() {
        return "TOOL_VNPT_ANDROID/1.1.1";
    }

    private String safeHeaders(JSONObject headers) {
        JSONObject out = new JSONObject();
        Iterator<String> it = headers.keys();
        while (it.hasNext()) {
            String k = it.next();
            String lower = k.toLowerCase(Locale.US);
            try { out.put(k, (lower.contains("authorization") || lower.contains("cookie") || lower.contains("token") || lower.contains("secret") || lower.contains("password")) ? "[REDACTED]" : headers.opt(k)); }
            catch (Exception ignored) {}
        }
        return out.toString();
    }

    private String safeResponseHeaders(java.util.Map<String, java.util.List<String>> headers) {
        JSONObject out = new JSONObject();
        for (java.util.Map.Entry<String, java.util.List<String>> e : headers.entrySet()) {
            String k = e.getKey().toLowerCase(Locale.US);
            if (k.contains("set-cookie") || k.contains("authorization") || k.contains("token")) continue;
            try { out.put(k, e.getValue()); } catch (Exception ignored) {}
        }
        return out.toString();
    }

    private String safeBody(String body) {
        if (body == null || body.isEmpty()) return "(empty)";
        String v = body.replaceAll("(?i)(\"?(?:password|passwd|pass|otp|secretCode|client_secret|access_token|refresh_token|token)\"?\\s*[:=]\\s*\")([^\"]*)(\")", "$1[REDACTED]$3");
        v = v.replaceAll("(?i)(password|passwd|otp|secretCode|client_secret|access_token|refresh_token|token)=([^&\\s]+)", "$1=[REDACTED]");
        return v.length() > 1800 ? v.substring(0, 1800) + "...[truncated]" : v;
    }

    private void diag(String tag, String message) {
        String line = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.US).format(new Date()) + " [" + tag + "] " + message + "\n";
        Log.i("VNPT-DIAG", line.trim());
        synchronized (LOG_LOCK) {
            try (FileOutputStream out = webView.getContext().openFileOutput(DIAG_FILE, Context.MODE_APPEND)) {
                out.write(line.getBytes(StandardCharsets.UTF_8));
            } catch (Exception e) { Log.e("VNPT-DIAG", "Cannot write diagnostic log", e); }
        }
    }

    @JavascriptInterface
    public String diagnosticLog() {
        synchronized (LOG_LOCK) {
            try (FileInputStream in = webView.getContext().openFileInput(DIAG_FILE);
                 ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                byte[] buf = new byte[8192]; int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                return out.toString("UTF-8");
            } catch (Exception e) { return "Chưa có nhật ký: " + e.getMessage(); }
        }
    }

    @JavascriptInterface
    public void clearDiagnosticLog() {
        synchronized (LOG_LOCK) {
            try (FileOutputStream out = webView.getContext().openFileOutput(DIAG_FILE, Context.MODE_PRIVATE)) { out.write(new byte[0]); }
            catch (Exception e) { Log.e("VNPT-DIAG", "Cannot clear diagnostic log", e); }
        }
        diag("APP", "Đã xóa nhật ký theo yêu cầu người dùng");
    }

    @JavascriptInterface
    public void logFromJs(String level, String message) {
        diag("JS-" + (level == null ? "LOG" : level), message == null ? "" : message);
    }

    public void close() {
        executor.shutdownNow();
    }
}
