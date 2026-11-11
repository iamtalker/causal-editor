# 인과 편집기 안드로이드 앱

`프로그램/index.html`(PC 편집기 화면)을 그대로 쓰고, PC의 `server.js`가 하던 파일 저장 작업을 안드로이드 저장소에서 처리하는 Capacitor 앱입니다. 노드 파일 동기화는 Syncthing이 맡습니다.

## 구조

- `web/android-shim.js` : `/api/*` 요청을 기기 파일 작업으로 바꿔 주는 어댑터 (`server.js`와 같은 응답 형식)
- `web/android-touch.js` : 터치 조작 (노드 끌기, 화면 밀기, 두 손가락 확대·축소, 빈 곳 두 번 탭으로 노드 추가)
- `프로그램/md-graph.js` : 노드 Markdown 파일 ↔ 그래프 변환기. PC와 안드로이드가 같은 파일을 씁니다 (`copy-web.js`가 복사)
- `native/DataFilesPlugin.java` : 내장 저장소 파일 읽기·쓰기·목록, Markdown 열기 플러그인 (허용 범위는 `/storage/emulated/0` 안)
- `native/UpdatePlugin.java` : 앱 업데이트 확인·다운로드·설치 세션과 알림
- `native/UpdateReceiver.java` : 설치 결과 수신 (설치 확인 화면 띄우기, 실패 이유 알림)
- `native/ReplacedReceiver.java` : 새 버전으로 바뀐 뒤 '업데이트 완료' 알림
- `web/android-update.js` : 업데이트 띠, 업데이트 창, 6시간 자동 확인
- 매니페스트(`android/android/app/src/main/AndroidManifest.xml`)에 두 리시버와 알림 권한이 있습니다. 이 파일은 Capacitor 동기화가 덮어쓰지 않으므로 직접 관리합니다.
- `scripts/copy-web.js` : `프로그램/index.html`을 `www/`로 복사하고 어댑터를 끼워 넣음. PC용 HTML은 바꾸지 않음
- `android/` : Capacitor가 만든 안드로이드 프로젝트 (Gradle)

## 데이터 위치

- 기본 폴더: `/storage/emulated/0/Documents/인과편집기`
- 편집기 설정의 데이터 폴더 항목에서 다른 폴더를 고를 수 있습니다. 선택은 앱 WebView 저장소에 남습니다.
- 폴더 구조는 PC와 같습니다: `노드파일/`, `변경이력/`, 그리고 그래프 JSON 사본을 두는 `내부데이터/`
- 노드 Markdown 파일(`노드파일/`)이 그래프의 원본입니다. 앱은 파일에서 그래프를 만들고, `내부데이터/그래프.json`은 설정과 백업용입니다.
- Syncthing으로 이 폴더를 동기화하면 됩니다. 다른 기기에서 들어온 파일은 앱을 다시 열거나 `파일 다시 읽기` 버튼, 앱이 다시 보일 때 반영됩니다.

## 빌드 방법

필요한 것: Node.js 20 이상, JDK 21, Android SDK (`compileSdk 35`).

```bash
cd android
npm install
npm run build:apk
```

- Gradle이 JDK 21을 써야 합니다. 이 PC에서는 `JAVA_HOME="C:/Program Files/Eclipse Adoptium/jdk-21.0.13.9-hotspot"`로 지정해 빌드했습니다.
- `android/local.properties`의 `sdk.dir`은 PC마다 다르므로 저장소에 올리지 않습니다 (`android/android/.gitignore`에 포함).
- 결과물: `android/android/app/build/outputs/apk/debug/app-debug.apk`

웹 화면만 바꾼 뒤에는 `npm run sync`로 다시 복사하고 빌드합니다.

## 처음 실행할 때

- "모든 파일 관리" 권한 화면이 열립니다. 허용해야 데이터 폴더에 저장됩니다 (Android 11 이상).

## 업데이트

- 앱을 열면 6시간마다 GitHub 최신 릴리즈를 조용히 확인합니다. 새 버전이 있으면 화면 위 띠로 알리고, `업데이트`를 누르면 업데이트 창이 열립니다. 설정(업데이트 창의 체크박스)에서 끌 수 있습니다.
- 헤더 오른쪽 끝의 `업데이트` 버튼으로 언제든 직접 확인할 수 있습니다.
- `업데이트 확인`은 GitHub 릴리즈의 최신 APK를 찾습니다. 저장소가 공개라서 토큰 없이 동작합니다.
- 새 버전이 있으면 `다운로드 후 설치`를 누릅니다. 다운로드 진행률이 막대와 퍼센트로 표시되고, 알림창에도 보입니다.
- 설치는 PackageInstaller 세션으로 진행합니다. 시스템 설치 확인 화면이 뜨면 `설치`(또는 `업데이트`)를 눌러 주세요. 설치 중에는 앱이 잠깐 꺼졌다 켜집니다.
- 설치 전에 "출처를 알 수 없는 앱 설치"를 이 앱에 허용해야 합니다. 허용 화면은 앱 안의 버튼으로 바로 열립니다.
- 새 버전으로 켜지면 '앱 업데이트 완료' 알림이 뜨고, 앱 화면 위에도 한 번 알려 줍니다.
- 알림은 Android 13 이상에서 알림 권한을 허용해야 보입니다. 권한이 없어도 설치는 진행됩니다.
- 현재 최신 릴리즈: v1.2.0 (빌드 7)

릴리즈 목록: https://github.com/iamtalker/causal-editor-android/releases

## 아직 안 되는 것 / 차이점

- 노드 md 파일 열기 버튼은 기기에 설치된 텍스트 보기·편집 앱을 고르는 창을 엽니다. `text/plain`으로 요청하므로, 마크다운 전용 앱만 있으면 목록에 안 나올 수 있습니다.
- 화살표 연결(PC의 Shift+클릭)은 터치에서 아직 되지 않습니다. 화살표 연결은 PC에서 하세요.
- 터치 조작은 실제 기기에서 확인하지 않았습니다. 빌드 후 기기에서 노드 끌기, 두 손가락 확대, 두 번 탭 추가를 한 번씩 확인해 주세요.
- 에뮬레이터나 실제 기기에서는 아직 실행해 보지 않았습니다. 웹 쪽 동작(노드 파일 읽기·쓰기, 끌기, 확대, md 열기 요청)은 모의 파일 저장소를 붙인 브라우저에서 확인했습니다.
