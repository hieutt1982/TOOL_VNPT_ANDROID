package com.vnpt.tool;

import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import javax.net.ssl.*;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;
import okhttp3.Cookie;
import okhttp3.CookieJar;
import okhttp3.ConnectionPool;
import okhttp3.HttpUrl;
import okhttp3.OkHttpClient;
import okhttp3.Protocol;

public final class ApiClient {
    private static OkHttpClient normal, modem, oneLink;
    private static final CookieJar COOKIE_JAR = new CookieJar() {
        private final Map<String, Map<String, Cookie>> store = new ConcurrentHashMap<>();
        @Override public void saveFromResponse(HttpUrl url, List<Cookie> cookies) {
            Map<String, Cookie> host = store.computeIfAbsent(url.host(), k -> new ConcurrentHashMap<>());
            long now = System.currentTimeMillis();
            for (Cookie c : cookies) {
                if (c.expiresAt() <= now) host.remove(c.name());
                else host.put(c.name(), c);
            }
        }
        @Override public List<Cookie> loadForRequest(HttpUrl url) {
            Map<String, Cookie> host = store.get(url.host());
            if (host == null) return Collections.emptyList();
            long now = System.currentTimeMillis();
            List<Cookie> out = new ArrayList<>();
            for (Cookie c : host.values()) {
                if (c.expiresAt() <= now) host.remove(c.name());
                else if (c.matches(url)) out.add(c);
            }
            return out;
        }
    };
    private ApiClient() {}

    public static synchronized OkHttpClient normal() {
        if (normal == null) normal = new OkHttpClient.Builder()
            .cookieJar(COOKIE_JAR).connectTimeout(20, TimeUnit.SECONDS)
            .readTimeout(45, TimeUnit.SECONDS).writeTimeout(45, TimeUnit.SECONDS)
            .followRedirects(false).followSslRedirects(false).build();
        return normal;
    }

    /** OneLink Node.js original used https.request (HTTP/1.1). Keep the same
     * protocol and normal certificate validation to avoid protocol differences. */
    public static synchronized OkHttpClient oneLink() {
        if (oneLink == null) oneLink = new OkHttpClient.Builder()
            // Node https.request() gốc không có CookieJar; không tự gửi cookie
            // nhận được ở bước 1 sang bước OTP.
            .protocols(Collections.singletonList(Protocol.HTTP_1_1))
            .connectTimeout(20, TimeUnit.SECONDS)
            .readTimeout(45, TimeUnit.SECONDS)
            .writeTimeout(45, TimeUnit.SECONDS)
            .followRedirects(false).followSslRedirects(false).build();
        return oneLink;
    }

    public static synchronized OkHttpClient modem() throws Exception {
        if (modem != null) return modem;
        X509TrustManager tm = new X509TrustManager() {
            public void checkClientTrusted(X509Certificate[] c, String a) {}
            public void checkServerTrusted(X509Certificate[] c, String a) {}
            public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
        };
        SSLContext ssl = SSLContext.getInstance("TLS");
        ssl.init(null, new TrustManager[]{tm}, new SecureRandom());
        // Modem scripts manage their own Cookie header (G040H needs to send
        // SESSIONID and its JavaScript-generated base64 cookie together).
        // OkHttp's BridgeInterceptor otherwise replaces an explicit Cookie
        // header with cookies from CookieJar and drops the base64 value.
        modem = new OkHttpClient.Builder()
            .sslSocketFactory(ssl.getSocketFactory(), tm)
            .hostnameVerifier((host, session) -> isPrivateModemHost(host))
            // Modem firmware thường đóng socket sau khi áp dụng cấu hình/reboot.
            // Không giữ socket idle để lần cấu hình kế tiếp không dùng lại kết nối cũ.
            .connectionPool(new ConnectionPool(0, 1, TimeUnit.NANOSECONDS))
            .connectTimeout(15, TimeUnit.SECONDS).readTimeout(35, TimeUnit.SECONDS)
            .writeTimeout(35, TimeUnit.SECONDS).followRedirects(false)
            .followSslRedirects(false).build();
        return modem;
    }

    public static boolean isPrivateModemHost(String host) {
        if (host == null) return false;
        String s = host.toLowerCase(Locale.US);
        if (s.equals("localhost") || s.equals("127.0.0.1")) return true;
        if (!s.matches("[0-9]{1,3}(\\.[0-9]{1,3}){3}")) return false;
        String[] a = s.split("\\.");
        int x, y;
        try {
            for (String v : a) if (Integer.parseInt(v) > 255) return false;
            x = Integer.parseInt(a[0]); y = Integer.parseInt(a[1]);
        } catch (Exception e) { return false; }
        return x == 10 || x == 127 || (x == 192 && y == 168)
            || (x == 172 && y >= 16 && y <= 31) || (x == 169 && y == 254);
    }
}
