package com.causaleditor.app;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

// 웹 편집기가 쓰는 파일 작업을 안드로이드 저장소에서 처리합니다.
// 허용 범위는 내장 저장소(/storage/emulated/0) 안으로 제한합니다.
@CapacitorPlugin(name = "DataFiles")
public class DataFilesPlugin extends Plugin {
    private static final String ROOT = "/storage/emulated/0";

    private boolean hasAccess() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.R || Environment.isExternalStorageManager();
    }

    private File safe(String p) throws IOException {
        if (p == null || p.isEmpty()) throw new IOException("경로가 비어 있습니다.");
        File f = new File(p).getCanonicalFile();
        String c = f.getPath();
        if (!(c.equals(ROOT) || c.startsWith(ROOT + "/"))) throw new IOException("허용되지 않은 경로입니다.");
        return f;
    }

    private String needAccess() {
        return hasAccess() ? null : "파일 접근 권한이 없습니다. 설정 화면에서 '모든 파일 관리' 권한을 허용해 주세요.";
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("granted", hasAccess());
        call.resolve(ret);
    }

    @PluginMethod
    public void openAccessSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                Uri.parse("package:" + getContext().getPackageName()));
        getActivity().startActivity(intent);
        call.resolve();
    }

    @PluginMethod
    public void readText(PluginCall call) {
        String err = needAccess();
        if (err != null) { call.reject(err); return; }
        try {
            File f = safe(call.getString("path"));
            JSObject ret = new JSObject();
            if (!f.isFile()) {
                ret.put("exists", false);
                ret.put("text", "");
            } else {
                ret.put("exists", true);
                ret.put("text", new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8));
            }
            call.resolve(ret);
        } catch (Exception e) { call.reject(e.getMessage()); }
    }

    @PluginMethod
    public void writeText(PluginCall call) {
        String err = needAccess();
        if (err != null) { call.reject(err); return; }
        try {
            File f = safe(call.getString("path"));
            File parent = f.getParentFile();
            if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new IOException("폴더를 만들지 못했습니다.");
            Files.write(f.toPath(), call.getString("text", "").getBytes(StandardCharsets.UTF_8));
            call.resolve();
        } catch (Exception e) { call.reject(e.getMessage()); }
    }

    @PluginMethod
    public void mkdirs(PluginCall call) {
        String err = needAccess();
        if (err != null) { call.reject(err); return; }
        try {
            File f = safe(call.getString("path"));
            if (!f.isDirectory() && !f.mkdirs()) throw new IOException("폴더를 만들지 못했습니다.");
            call.resolve();
        } catch (Exception e) { call.reject(e.getMessage()); }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String err = needAccess();
        if (err != null) { call.reject(err); return; }
        try {
            File f = safe(call.getString("path"));
            if (f.exists() && !f.delete()) throw new IOException("삭제하지 못했습니다.");
            call.resolve();
        } catch (Exception e) { call.reject(e.getMessage()); }
    }

    // 노드 Markdown 파일을 다른 앱(텍스트·마크다운 보기 앱)으로 엽니다.
    // 파일 공유는 FileProvider(file_paths.xml의 외부 저장소 루트)로 임시 읽기 권한을 줍니다.
    @PluginMethod
    public void openFile(PluginCall call) {
        String err = needAccess();
        if (err != null) { call.reject(err); return; }
        try {
            File f = safe(call.getString("path"));
            if (!f.isFile()) { call.reject("파일을 찾지 못했습니다."); return; }
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", f);
            Intent view = new Intent(Intent.ACTION_VIEW);
            view.setDataAndType(uri, "text/plain");
            view.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            Intent chooser = Intent.createChooser(view, "노드 파일 열기");
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(chooser);
            call.resolve();
        } catch (Exception e) { call.reject("파일을 열지 못했습니다: " + e.getMessage()); }
    }

    // 폴더 안의 항목 목록 (dirs, files)
    @PluginMethod
    public void list(PluginCall call) {
        String err = needAccess();
        if (err != null) { call.reject(err); return; }
        try {
            File dir = safe(call.getString("path"));
            if (!dir.isDirectory()) { call.reject("폴더가 아닙니다."); return; }
            File[] entries = dir.listFiles();
            JSArray dirs = new JSArray();
            JSArray files = new JSArray();
            if (entries != null) {
                for (File e : entries) {
                    JSObject item = new JSObject();
                    item.put("name", e.getName());
                    item.put("path", e.getPath());
                    if (e.isDirectory()) dirs.put(item); else if (e.isFile()) files.put(item);
                }
            }
            JSObject ret = new JSObject();
            ret.put("dirs", dirs);
            ret.put("files", files);
            call.resolve(ret);
        } catch (Exception e) { call.reject(e.getMessage()); }
    }
}
