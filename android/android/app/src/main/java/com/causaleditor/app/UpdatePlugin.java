package com.causaleditor.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

// 앱 자동 업데이트 (안드로이드 앱 안에서 새 버전을 받아 설치합니다).
// GitHub 최신 릴리즈를 확인하고, 받은 APK를 설치 세션(PackageInstaller)에 넣어 설치 확인 화면을 띄웁니다.
// 설치 결과는 UpdateReceiver가 받고, 단계는 installState로 JS가 읽습니다.
// 다운로드 진행률은 JS가 progress 메서드를 주기적으로 호출해서 읽습니다.
@CapacitorPlugin(name = "Updater")
public class UpdatePlugin extends Plugin {
    static final String CHANNEL = "update";
    static final int NOTICE_ID = 2;
    static final String RESULT_ACTION = "com.causaleditor.app.INSTALL_RESULT";

    // 설치 단계: 0 대기 · 2 설치 준비 · 3 설치 확인 화면 · 4 설치 중(앱이 곧 꺼짐) · 5 완료 · 9 실패
    private static volatile int installStep = 0;
    private static volatile String installMessage = "";

    private static volatile long downloaded = 0;
    private static volatile long totalBytes = 0;
    private static volatile boolean downloading = false;

    @PluginMethod
    public void appInfo(PluginCall call) {
        try {
            android.content.pm.PackageInfo info = getContext().getPackageManager()
                    .getPackageInfo(getContext().getPackageName(), 0);
            JSObject ret = new JSObject();
            ret.put("versionName", info.versionName);
            ret.put("versionCode", info.versionCode);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void checkLatest(PluginCall call) {
        final String repo = call.getString("repo", "");
        final String token = call.getString("token", "");
        new Thread(() -> {
            try {
                HttpURLConnection c = open(new URL("https://api.github.com/repos/" + repo + "/releases/latest"),
                        token, "application/vnd.github+json");
                int code = c.getResponseCode();
                if (code == 404) { call.reject("릴리즈를 찾지 못했습니다. 저장소 이름과 토큰을 확인해 주세요."); return; }
                if (code == 401 || code == 403) { call.reject("GitHub 인증에 실패했습니다. 토큰을 확인해 주세요."); return; }
                if (code != 200) { call.reject("업데이트 확인 실패 (HTTP " + code + ")"); return; }
                JSONObject rel = new JSONObject(readAll(c.getInputStream()));
                JSONObject apk = null;
                JSONArray assets = rel.optJSONArray("assets");
                if (assets != null) {
                    for (int i = 0; i < assets.length(); i++) {
                        JSONObject a = assets.getJSONObject(i);
                        if (a.optString("name", "").toLowerCase().endsWith(".apk")) { apk = a; break; }
                    }
                }
                if (apk == null) { call.reject("최신 릴리즈에 APK 파일이 없습니다."); return; }
                JSObject ret = new JSObject();
                ret.put("tag", rel.optString("tag_name", ""));
                ret.put("notes", rel.optString("body", ""));
                ret.put("assetName", apk.getString("name"));
                ret.put("assetUrl", apk.getString("url"));
                ret.put("assetSize", apk.optLong("size", 0));
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("업데이트 확인 실패: " + e.getMessage());
            }
        }).start();
    }

    @PluginMethod
    public void download(PluginCall call) {
        final Context ctx = getContext();
        final String url = call.getString("url", "");
        final String token = call.getString("token", "");
        final String fileName = call.getString("fileName", "update.apk").replaceAll("[^A-Za-z0-9._-]", "_");
        new Thread(() -> {
            downloaded = 0;
            totalBytes = 0;
            downloading = true;
            try {
                HttpURLConnection c = open(new URL(url), token, "application/octet-stream");
                int code = c.getResponseCode();
                // GitHub는 실제 파일을 다른 주소로 넘겨줍니다. 그 주소에는 토큰을 보내지 않습니다.
                if (code == 301 || code == 302 || code == 303 || code == 307 || code == 308) {
                    String location = c.getHeaderField("Location");
                    c.disconnect();
                    c = open(new URL(location), null, "application/octet-stream");
                    code = c.getResponseCode();
                }
                if (code != 200) { call.reject("다운로드 실패 (HTTP " + code + ")"); cancelNotice(ctx); return; }
                totalBytes = c.getContentLengthLong();
                File dir = new File(ctx.getCacheDir(), "updates");
                if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("폴더를 만들지 못했습니다.");
                File out = new File(dir, fileName);
                int lastPct = -1;
                try (InputStream in = c.getInputStream(); OutputStream os = new FileOutputStream(out)) {
                    byte[] buf = new byte[64 * 1024];
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        os.write(buf, 0, n);
                        downloaded += n;
                        if (totalBytes > 0) {
                            int pct = (int) (downloaded * 100 / totalBytes);
                            if (pct != lastPct) {
                                lastPct = pct;
                                notifyNow(ctx, "앱 업데이트", "새 버전 받는 중 " + pct + "%", pct);
                            }
                        }
                    }
                }
                JSObject ret = new JSObject();
                ret.put("path", out.getAbsolutePath());
                ret.put("size", out.length());
                call.resolve(ret);
            } catch (Exception e) {
                cancelNotice(ctx);
                call.reject("다운로드 실패: " + e.getMessage());
            } finally {
                downloading = false;
            }
        }).start();
    }

    @PluginMethod
    public void progress(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("downloading", downloading);
        ret.put("received", downloaded);
        ret.put("total", totalBytes);
        call.resolve(ret);
    }

    @PluginMethod
    public void canInstall(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("allowed", Build.VERSION.SDK_INT < Build.VERSION_CODES.O
                || getContext().getPackageManager().canRequestPackageInstalls());
        call.resolve(ret);
    }

    @PluginMethod
    public void openInstallSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:" + getContext().getPackageName()));
        getActivity().startActivity(intent);
        call.resolve();
    }

    // 설치 단계를 JS가 주기적으로 읽습니다. 앱이 교체되면 JS는 다시 시작되므로 완료 알림은 ReplacedReceiver가 맡습니다.
    @PluginMethod
    public void installState(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("step", installStep);
        ret.put("message", installMessage);
        call.resolve(ret);
    }

    // 받아 둔 APK를 설치 세션에 넣고 설치를 맡깁니다. 실제 확인 화면은 UpdateReceiver가 띄웁니다.
    @PluginMethod
    public void install(PluginCall call) {
        final Context ctx = getContext();
        File apk;
        try {
            apk = new File(call.getString("path", "")).getCanonicalFile();
            File updates = new File(ctx.getCacheDir(), "updates").getCanonicalFile();
            if (!apk.getPath().startsWith(updates.getPath() + File.separator) || !apk.isFile()) {
                call.reject("설치 파일을 찾지 못했습니다.");
                return;
            }
        } catch (IOException e) {
            call.reject("설치 파일을 확인하지 못했습니다: " + e.getMessage());
            return;
        }
        setInstallState(2, "설치를 준비하는 중…");
        final File file = apk;
        new Thread(() -> {
            try {
                startSession(ctx, file);
            } catch (Exception e) {
                setInstallState(9, "설치하지 못했습니다: " + e.getMessage());
                cancelNotice(ctx);
            }
        }).start();
        call.resolve();
    }

    private static void startSession(Context ctx, File apk) throws IOException {
        PackageInstaller pi = ctx.getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        if (Build.VERSION.SDK_INT >= 31) params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
        final int id = pi.createSession(params);
        // 설치가 실제로 시작되면 '설치 중' 단계로 넘깁니다. 앱이 교체되는 동안에도 알림이 남도록 합니다.
        PackageInstaller.SessionCallback cb = new PackageInstaller.SessionCallback() {
            private void installing() {
                if (installStep == 2 || installStep == 3) {
                    setInstallState(4, "설치하는 중… 앱이 곧 꺼졌다가 새 버전으로 다시 켜집니다(약 10~30초). 꺼져도 정상입니다");
                    notifyNow(ctx, "앱 업데이트", "설치하는 중… 앱이 곧 다시 켜집니다", -1);
                }
            }
            @Override public void onCreated(int sessionId) {}
            @Override public void onBadgingChanged(int sessionId) {}
            @Override public void onActiveChanged(int sessionId, boolean active) { if (sessionId == id && active) installing(); }
            @Override public void onProgressChanged(int sessionId, float progress) { if (sessionId == id && progress > 0.95f) installing(); }
            @Override public void onFinished(int sessionId, boolean success) {
                if (sessionId != id) return;
                try { pi.unregisterSessionCallback(this); } catch (Exception ignored) { }
                if (!success && installStep != 5) { setInstallState(9, "설치하지 못했거나 취소했습니다"); cancelNotice(ctx); }
            }
        };
        pi.registerSessionCallback(cb, new Handler(Looper.getMainLooper()));
        try (PackageInstaller.Session s = pi.openSession(id)) {
            try (InputStream in = new FileInputStream(apk); OutputStream os = s.openWrite("app.apk", 0, apk.length())) {
                byte[] buf = new byte[256 * 1024];
                long total = Math.max(apk.length(), 1L);
                long done = 0;
                int last = -1;
                int n;
                while ((n = in.read(buf)) > 0) {
                    os.write(buf, 0, n);
                    done += n;
                    int pct = (int) (done * 100 / total);
                    if (pct != last) {
                        last = pct;
                        setInstallState(2, "설치를 준비하는 중… " + pct + "%");
                        notifyNow(ctx, "앱 업데이트", "설치를 준비하는 중… " + pct + "%", pct);
                    }
                }
                s.fsync(os);
            }
            Intent intent = new Intent(ctx, UpdateReceiver.class).setAction(RESULT_ACTION).setPackage(ctx.getPackageName());
            int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
            s.commit(PendingIntent.getBroadcast(ctx, id, intent, flags).getIntentSender());
        }
        setInstallState(2, "설치 확인 화면을 기다리는 중…");
    }

    static void setInstallState(int step, String message) {
        installStep = step;
        installMessage = message;
    }

    /** 작업표시줄 알림(알림 권한이 없으면 조용히 건너뜀) */
    static void notifyNow(Context ctx, String title, String text, int pct) {
        try {
            NotificationManager nm = ctx.getSystemService(NotificationManager.class);
            Notification.Builder b;
            if (Build.VERSION.SDK_INT >= 26) {
                nm.createNotificationChannel(new NotificationChannel(CHANNEL, "앱 업데이트", NotificationManager.IMPORTANCE_LOW));
                b = new Notification.Builder(ctx, CHANNEL);
            } else {
                b = new Notification.Builder(ctx);
            }
            b.setSmallIcon(R.mipmap.ic_launcher).setContentTitle(title).setContentText(text).setOngoing(true);
            if (pct >= 0 && pct <= 100) b.setProgress(100, pct, false); else b.setProgress(0, 0, true);
            nm.notify(NOTICE_ID, b.build());
        } catch (Exception ignored) { }
    }

    static void cancelNotice(Context ctx) {
        try { ctx.getSystemService(NotificationManager.class).cancel(NOTICE_ID); } catch (Exception ignored) { }
    }

    /** 앱이 새 버전으로 바뀐 직후 알림 (ReplacedReceiver가 호출) */
    static void notifyDone(Context ctx) {
        try {
            NotificationManager nm = ctx.getSystemService(NotificationManager.class);
            Notification.Builder b;
            if (Build.VERSION.SDK_INT >= 26) {
                nm.createNotificationChannel(new NotificationChannel(CHANNEL, "앱 업데이트", NotificationManager.IMPORTANCE_LOW));
                b = new Notification.Builder(ctx, CHANNEL);
            } else {
                b = new Notification.Builder(ctx);
            }
            String version = "";
            try { version = ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0).versionName; } catch (Exception ignored) { }
            PendingIntent open = PendingIntent.getActivity(ctx, 3, new Intent(ctx, MainActivity.class),
                    PendingIntent.FLAG_IMMUTABLE);
            b.setSmallIcon(R.mipmap.ic_launcher).setContentTitle("앱 업데이트 완료")
                    .setContentText("새 버전 " + version + "(으)로 바뀌었습니다")
                    .setAutoCancel(true).setContentIntent(open);
            nm.notify(NOTICE_ID, b.build());
        } catch (Exception ignored) { }
    }

    private static HttpURLConnection open(URL url, String token, String accept) throws IOException {
        HttpURLConnection c = (HttpURLConnection) url.openConnection();
        c.setInstanceFollowRedirects(false);
        c.setConnectTimeout(15000);
        c.setReadTimeout(30000);
        c.setRequestProperty("Accept", accept);
        c.setRequestProperty("User-Agent", "causal-editor-android");
        if (token != null && !token.isEmpty()) c.setRequestProperty("Authorization", "Bearer " + token);
        return c;
    }

    private static String readAll(InputStream in) throws IOException {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
        return bos.toString("UTF-8");
    }
}
