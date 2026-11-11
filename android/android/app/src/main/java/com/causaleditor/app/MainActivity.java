package com.causaleditor.app;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        registerPlugin(DataFilesPlugin.class);
        registerPlugin(UpdatePlugin.class);
        super.onCreate(savedInstanceState);

        // 뒤로 가기: 웹 화면에서 열린 창(설정 등)을 먼저 닫고, 닫을 것이 없을 때만 기본 동작(종료)을 합니다.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                getBridge().getWebView().evaluateJavascript(
                        "(window.__androidBack ? window.__androidBack() : false)",
                        value -> {
                            if ("true".equals(value)) return;   // 웹에서 창을 하나 닫았습니다
                            setEnabled(false);
                            getOnBackPressedDispatcher().onBackPressed();
                            setEnabled(true);
                        });
            }
        });
    }
}
