package com.vnpt.tool;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import okhttp3.HttpUrl;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;

/** Downloads the public Drive APK and hands it to Android's package installer. */
final class AppUpdater {
    private static final String DRIVE_FILE_ID = "1PYwhZWaJOaSSDyHLXDtNytJKTcCdmmxB";
    private static final long MAX_APK_BYTES = 150L * 1024L * 1024L;
    private static final Pattern DRIVE_UUID = Pattern.compile("name=\\\"uuid\\\"\\s+value=\\\"([^\\\"]+)\\\"", Pattern.CASE_INSENSITIVE);
    static final String INSTALL_RESULT_ACTION = "com.vnpt.tool.APP_UPDATE_INSTALL_RESULT";

    interface Progress {
        void update(String message, int percent, String state);
    }

    private AppUpdater() {}

    static File download(Context context, Progress progress) throws Exception {
        HttpUrl page = new HttpUrl.Builder().scheme("https").host("drive.google.com")
                .addPathSegment("uc").addQueryParameter("export", "download")
                .addQueryParameter("id", DRIVE_FILE_ID).build();
        String downloadUrl = page.toString();
        for (int attempt = 0; attempt < 4; attempt++) {
            Request request = new Request.Builder().url(downloadUrl)
                    .header("User-Agent", "Mozilla/5.0 (Linux; Android) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36")
                    .header("Accept", "application/octet-stream,text/html;q=0.9,*/*;q=0.8").get().build();
            try (Response response = ApiClient.normal().newCall(request).execute()) {
                if (response.isRedirect()) {
                    String location = response.header("Location");
                    if (location == null) throw new java.io.IOException("Drive chuyển hướng nhưng không trả địa chỉ tải.");
                    HttpUrl target = response.request().url().resolve(location);
                    if (target == null || !isDriveHost(target.host())) throw new java.io.IOException("Link tải chuyển tới máy chủ không được phép.");
                    downloadUrl = target.toString();
                    continue;
                }
                if (!response.isSuccessful()) throw new java.io.IOException("Google Drive trả HTTP " + response.code());
                ResponseBody body = response.body();
                if (body == null) throw new java.io.IOException("Google Drive không trả dữ liệu APK.");
                String contentType = body.contentType() == null ? "" : body.contentType().toString().toLowerCase(java.util.Locale.US);
                if (contentType.contains("text/html")) {
                    String html = body.string();
                    Matcher uuid = DRIVE_UUID.matcher(html);
                    if (!uuid.find()) throw new java.io.IOException("Drive không cho tải file. Kiểm tra quyền chia sẻ ‘Bất kỳ ai có liên kết’.");
                    HttpUrl.Builder direct = new HttpUrl.Builder().scheme("https").host("drive.usercontent.google.com")
                            .addPathSegment("download").addQueryParameter("id", DRIVE_FILE_ID)
                            .addQueryParameter("export", "download").addQueryParameter("confirm", "t")
                            .addQueryParameter("uuid", uuid.group(1));
                    downloadUrl = direct.build().toString();
                    continue;
                }
                long length = body.contentLength();
                if (length > MAX_APK_BYTES) throw new java.io.IOException("APK lớn hơn giới hạn 150 MB.");
                File apk = new File(context.getCacheDir(), "tool-vnpt-update.apk");
                try (InputStream in = body.byteStream(); OutputStream out = new FileOutputStream(apk, false)) {
                    byte[] buffer = new byte[64 * 1024];
                    long copied = 0;
                    int read;
                    int lastReported = -1;
                    while ((read = in.read(buffer)) != -1) {
                        copied += read;
                        if (copied > MAX_APK_BYTES) throw new java.io.IOException("APK lớn hơn giới hạn 150 MB.");
                        out.write(buffer, 0, read);
                        if (length > 0) {
                            int percent = (int) Math.min(99, copied * 100 / length);
                            if (percent != lastReported && percent % 5 == 0) {
                                progress.update("Đang tải APK… " + percent + "%", percent, "downloading");
                                lastReported = percent;
                            }
                        } else if (copied % (1024 * 1024) < buffer.length) {
                            progress.update("Đã tải " + (copied / (1024 * 1024)) + " MB…", -1, "downloading");
                        }
                    }
                    out.flush();
                }
                validateApk(context, apk);
                progress.update("Tải APK xong. Đang mở trình cài đặt…", 100, "installing");
                return apk;
            }
        }
        throw new java.io.IOException("Không lấy được file APK từ Google Drive sau nhiều lần chuyển hướng.");
    }

    static void install(Context context, File apk) throws Exception {
        if (Build.VERSION.SDK_INT >= 26 && !context.getPackageManager().canRequestPackageInstalls()) {
            throw new SecurityException("Android chưa cho phép VNPT TOOL cài ứng dụng. Hãy bật quyền ‘Cài ứng dụng không rõ nguồn gốc’ rồi bấm Cập nhật lại.");
        }
        PackageInstaller installer = context.getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        params.setAppPackageName(context.getPackageName());
        params.setSize(apk.length());
        int sessionId = installer.createSession(params);
        try (PackageInstaller.Session session = installer.openSession(sessionId);
             InputStream in = new FileInputStream(apk);
             OutputStream out = session.openWrite("base.apk", 0, apk.length())) {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read);
            session.fsync(out);
            Intent callback = new Intent(context, MainActivity.class).setAction(INSTALL_RESULT_ACTION);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= 31) flags |= PendingIntent.FLAG_MUTABLE;
            PendingIntent pending = PendingIntent.getActivity(context, sessionId, callback, flags);
            session.commit(pending.getIntentSender());
        } catch (Exception e) {
            try { installer.abandonSession(sessionId); } catch (Exception ignored) {}
            throw e;
        }
    }

    private static void validateApk(Context context, File apk) throws Exception {
        if (!apk.isFile() || apk.length() < 4) throw new java.io.IOException("File tải về quá nhỏ, không phải APK hợp lệ.");
        try (InputStream in = new FileInputStream(apk)) {
            if (in.read() != 'P' || in.read() != 'K') throw new java.io.IOException("Google Drive trả về nội dung không phải file APK.");
        }
        PackageInfo info = context.getPackageManager().getPackageArchiveInfo(apk.getAbsolutePath(), 0);
        if (info == null || !context.getPackageName().equals(info.packageName)) {
            throw new java.io.IOException("APK tải về không thuộc ứng dụng VNPT TOOL.");
        }
    }

    private static boolean isDriveHost(String host) {
        return "drive.google.com".equalsIgnoreCase(host)
                || "drive.usercontent.google.com".equalsIgnoreCase(host)
                || host.toLowerCase(java.util.Locale.US).endsWith(".googleusercontent.com");
    }
}
