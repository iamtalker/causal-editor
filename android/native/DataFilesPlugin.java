package com.causaleditor.app;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.DocumentsContract;
import android.provider.Settings;

import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.annotation.ActivityCallback;
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
        if (!allowed(c)) throw new IOException("허용되지 않은 경로입니다.");
        return f;
    }

    // 허용 범위: 내장 저장소(/storage/emulated/0 안), 저장소 목록(/storage, 폴더 고르기용),
    // 그리고 SD 카드 같은 외부 저장소(/storage/<볼륨 이름> 안). 'self'는 제외합니다.
    private static boolean allowed(String c) {
        if (c.equals(ROOT) || c.startsWith(ROOT + "/")) return true;
        if (c.equals("/storage")) return true;
        return c.matches("^/storage/(?!self(/|$))[^/]+(/.*)?$");
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

    // 기기의 기본 파일 탐색기로 폴더를 고릅니다 (SD 카드 포함). 결과는 파일 경로로 바꿔 돌려줍니다.
    @PluginMethod
    public void pickFolder(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        startActivityForResult(call, intent, "pickFolderResult");
    }

    @ActivityCallback
    private void pickFolderResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null || data.getData() == null) {
            call.reject("폴더 고르기를 취소했습니다.");
            return;
        }
        String path = treeUriToPath(data.getData());
        if (path == null) {
            call.reject("이 위치는 파일 경로로 쓸 수 없습니다. 내장 저장소나 SD 카드의 폴더를 고르세요.");
            return;
        }
        try {
            File f = safe(path);
            if (!f.isDirectory()) { call.reject("폴더가 아닙니다."); return; }
            JSObject ret = new JSObject();
            ret.put("path", f.getPath());
            call.resolve(ret);
        } catch (IOException e) {
            call.reject("허용되지 않은 폴더입니다: " + e.getMessage());
        }
    }

    // 파일 탐색기의 문서 주소를 파일 경로로 바꿉니다.
    // 예: "primary:Documents/인과편집기" → /storage/emulated/0/Documents/인과편집기, "1234-ABCD:" → /storage/1234-ABCD
    private static String treeUriToPath(Uri uri) {
        if (!"com.android.externalstorage.documents".equals(uri.getAuthority())) return null;
        String docId;
        try { docId = DocumentsContract.getTreeDocumentId(uri); } catch (Exception e) { return null; }
        int colon = docId.indexOf(':');
        if (colon < 0) return null;
        String volume = docId.substring(0, colon);
        String rel = docId.substring(colon + 1);
        String base = "primary".equalsIgnoreCase(volume) ? ROOT : "/storage/" + volume;
        return rel.isEmpty() ? base : base + "/" + rel;
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
