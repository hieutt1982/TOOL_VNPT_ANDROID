package com.vnpt.tool;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.os.Build;

import org.json.JSONObject;

import java.io.IOException;

import okhttp3.HttpUrl;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;

/** Checks the latest APK version using a public version.json file on Google Drive. */
final class AppUpdater {
    // Google Drive ID of version.json
    private static final String VERSION_JSON_FILE_ID = "1i5zATdaEu-cVQsKRRe5n2EhjXTAtTjcK";
    private static final long MAX_JSON_BYTES = 1024L * 1024L;

    interface Progress { void update(String message); }

    static final class VersionResult {
        final long installedCode;
        final String installedName;
        final long driveCode;
        final String driveName;
        final String apkFileId;
        final String description;

        VersionResult(long installedCode, String installedName, long driveCode,
                      String driveName, String apkFileId, String description) {
            this.installedCode = installedCode;
            this.installedName = installedName;
            this.driveCode = driveCode;
            this.driveName = driveName;
            this.apkFileId = apkFileId;
            this.description = description;
        }

        boolean hasUpdate() { return driveCode > installedCode; }
    }

    private AppUpdater() {}

    static VersionResult check(Context context, Progress progress) throws Exception {
        progress.update("Đang đọc version.json trên Google Drive…");

        PackageManager pm = context.getPackageManager();
        PackageInfo installed = pm.getPackageInfo(context.getPackageName(), 0);
        long installedCode = versionCode(installed);

        JSONObject json = downloadVersionJson();
        long remoteCode = json.getLong("versionCode");
        String remoteName = json.optString("versionName", String.valueOf(remoteCode));
        String apkFileId = json.optString("apkFileId", "").trim();
        String description = json.optString("description", "");

        if (remoteCode <= 0) throw new IOException("version.json có versionCode không hợp lệ.");
        if (apkFileId.isEmpty()) throw new IOException("version.json chưa có apkFileId.");
        if (!apkFileId.matches("[A-Za-z0-9_-]{10,}")) {
            throw new IOException("apkFileId trong version.json không hợp lệ.");
        }

        return new VersionResult(installedCode, installed.versionName,
                remoteCode, remoteName, apkFileId, description);
    }

    private static long versionCode(PackageInfo info) {
        return Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode;
    }

    private static JSONObject downloadVersionJson() throws Exception {
        HttpUrl url = new HttpUrl.Builder().scheme("https").host("drive.google.com")
                .addPathSegment("uc")
                .addQueryParameter("export", "download")
                .addQueryParameter("id", VERSION_JSON_FILE_ID)
                .build();

        Request request = new Request.Builder().url(url)
                .header("User-Agent", "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36")
                .header("Accept", "application/json,text/plain,*/*")
                .get().build();

        try (Response response = ApiClient.normal().newCall(request).execute()) {
            if (!response.isSuccessful()) {
                throw new IOException("Không đọc được version.json. Google Drive HTTP " + response.code());
            }
            ResponseBody body = response.body();
            if (body == null) throw new IOException("Google Drive không trả nội dung version.json.");
            long length = body.contentLength();
            if (length > MAX_JSON_BYTES) throw new IOException("version.json vượt quá 1 MB.");
            String content = body.string();
            if (content.length() > MAX_JSON_BYTES) throw new IOException("version.json vượt quá 1 MB.");
            String trimmed = content.trim();
            if (!trimmed.startsWith("{")) {
                throw new IOException("Google Drive không trả JSON. Hãy bật chia sẻ 'Bất kỳ ai có đường liên kết' cho version.json.");
            }
            try {
                return new JSONObject(trimmed);
            } catch (Exception e) {
                throw new IOException("Nội dung version.json không đúng định dạng JSON.", e);
            }
        }
    }
}
