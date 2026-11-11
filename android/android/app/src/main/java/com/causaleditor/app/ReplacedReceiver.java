package com.causaleditor.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

// 앱이 새 버전으로 바뀐 직후 '업데이트 완료' 알림을 남깁니다.
public class ReplacedReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        if (!Intent.ACTION_MY_PACKAGE_REPLACED.equals(intent.getAction())) return;
        UpdatePlugin.notifyDone(ctx);
    }
}
