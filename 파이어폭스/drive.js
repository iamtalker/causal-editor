// 구글 드라이브 동기화 (파이어폭스 확장 전용).
// 사용자가 버튼을 누를 때만 드라이브와 통신합니다. 드라이브의 "인과편집기" 폴더에 노드 파일(.md)을 올리고 받습니다.
// 권한은 이 앱이 만든 파일에만 접근하는 drive.file 하나입니다. 로그인 토큰은 메모리에만 두고 저장하지 않습니다.
const Drive = (function () {
  const SCOPE = 'https://www.googleapis.com/auth/drive.file';
  const API = 'https://www.googleapis.com';
  const FOLDER_NAME = '인과편집기';
  const FOLDER_MIME = 'application/vnd.google-apps.folder';
  const CLIENT_KEY = 'causal-editor-google-client-id';
  const DEFAULT_CLIENT_ID = '';   // 배포용 클라이언트 ID를 넣으면 사용자가 설정에서 입력하지 않아도 됩니다

  let token = null, tokenExp = 0;
  const ext = () => (typeof browser !== 'undefined' ? browser : (typeof chrome !== 'undefined' ? chrome : null));

  function clientId() {
    try { return (localStorage.getItem(CLIENT_KEY) || DEFAULT_CLIENT_ID).trim(); } catch (e) { return DEFAULT_CLIENT_ID; }
  }
  function setClientId(id) {
    try { id = String(id || '').trim(); if (id) localStorage.setItem(CLIENT_KEY, id); else localStorage.removeItem(CLIENT_KEY); } catch (e) { /* 저장하지 못하면 이번에만 씁니다 */ }
    token = null; tokenExp = 0;
  }
  function redirectUrl() {
    const x = ext();
    return x && x.identity && x.identity.getRedirectURL ? x.identity.getRedirectURL() : '';
  }
  function logout() { token = null; tokenExp = 0; }

  async function login() {
    const id = clientId();
    if (!id) throw new Error('설정에서 구글 OAuth 클라이언트 ID를 먼저 입력하세요.');
    const x = ext();
    if (!x || !x.identity || !x.identity.launchWebAuthFlow) throw new Error('이 브라우저에서는 구글 로그인을 쓸 수 없습니다.');
    const state = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
    const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
      client_id: id, redirect_uri: redirectUrl(), response_type: 'token', scope: SCOPE, state, include_granted_scopes: 'true'
    });
    let result;
    try { result = await x.identity.launchWebAuthFlow({url, interactive: true}); }
    catch (e) { throw new Error('구글 로그인이 취소되었거나 실패했습니다. 클라이언트 ID와 리디렉션 URI 등록을 확인하세요.'); }
    const q = new URLSearchParams(String(result).split('#')[1] || '');
    if (q.get('error')) throw new Error(`구글 로그인 오류: ${q.get('error')}`);
    if (q.get('state') !== state || !q.get('access_token')) throw new Error('구글 로그인 응답이 올바르지 않습니다.');
    token = q.get('access_token');
    tokenExp = Date.now() + Math.max(60, Number(q.get('expires_in')) - 60) * 1000;
  }
  async function ensureToken() { if (!token || Date.now() >= tokenExp) await login(); }

  async function call(path, opt = {}, retry = true) {
    await ensureToken();
    const headers = {Authorization: `Bearer ${token}`, ...(opt.headers || {})};
    const res = await fetch(API + path, {...opt, headers});
    if (res.status === 401 && retry) { token = null; return call(path, opt, false); }
    if (!res.ok) {
      let msg = res.statusText;
      try { const j = await res.json(); msg = (j.error && j.error.message) || msg; } catch (e) { /* 본문이 없으면 상태 문구를 씁니다 */ }
      throw new Error(`드라이브 오류 ${res.status}: ${msg}`);
    }
    return res;
  }
  const json = async (path, opt) => (await call(path, opt)).json();

  async function sha(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
  }

  // 드라이브의 인과편집기 폴더 id. create가 거짓이면 없을 때 null을 돌려줍니다.
  async function folderId(create) {
    const q = `name='${FOLDER_NAME}' and mimeType='${FOLDER_MIME}' and trashed=false`;
    const r = await json(`/drive/v3/files?${new URLSearchParams({q, fields: 'files(id)', pageSize: '10'})}`);
    if (r.files && r.files.length) return r.files[0].id;
    if (!create) return null;
    const made = await json('/drive/v3/files?fields=id', {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({name: FOLDER_NAME, mimeType: FOLDER_MIME})
    });
    return made.id;
  }
  // 폴더 안의 파일 [{id, name, hash}]
  async function listFiles(fid) {
    const out = [];
    let pageToken = '';
    do {
      const p = {q: `'${fid}' in parents and trashed=false and mimeType!='${FOLDER_MIME}'`, fields: 'nextPageToken,files(id,name,appProperties)', pageSize: '1000'};
      if (pageToken) p.pageToken = pageToken;
      const r = await json(`/drive/v3/files?${new URLSearchParams(p)}`);
      for (const f of r.files || []) out.push({id: f.id, name: f.name, hash: f.appProperties && f.appProperties.h || ''});
      pageToken = r.nextPageToken || '';
    } while (pageToken);
    return out;
  }
  function multipart(meta, text) {
    const b = 'ce' + Math.random().toString(36).slice(2);
    return {
      type: `multipart/related; boundary=${b}`,
      body: `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\nContent-Type: text/markdown; charset=UTF-8\r\n\r\n${text}\r\n--${b}--`
    };
  }

  // 올릴 내용을 계산합니다. 로컬 파일 [{name, text}] → {folder, create[], update[], trash[], same}
  async function plan(files) {
    const fid = await folderId(false);
    const remote = fid ? await listFiles(fid) : [];
    const byName = new Map();
    for (const f of remote) if (!byName.has(f.name)) byName.set(f.name, f);
    const create = [], update = [], keep = new Set();
    let same = 0;
    for (const f of files) {
      const hash = await sha(f.text);
      const r = byName.get(f.name);
      keep.add(f.name);
      if (!r) create.push({...f, hash});
      else if (r.hash !== hash) update.push({...f, hash, id: r.id});
      else same++;
    }
    const trash = remote.filter(f => !keep.has(f.name) || byName.get(f.name) !== f);
    return {fid, create, update, trash, same};
  }
  async function push(p) {
    const fid = p.fid || await folderId(true);
    for (const f of p.create) {
      const m = multipart({name: f.name, parents: [fid], appProperties: {h: f.hash}}, f.text);
      await call('/upload/drive/v3/files?uploadType=multipart&fields=id', {method: 'POST', headers: {'Content-Type': m.type}, body: m.body});
    }
    for (const f of p.update) {
      const m = multipart({appProperties: {h: f.hash}}, f.text);
      await call(`/upload/drive/v3/files/${f.id}?uploadType=multipart&fields=id`, {method: 'PATCH', headers: {'Content-Type': m.type}, body: m.body});
    }
    for (const f of p.trash) {   // 영구 삭제하지 않고 드라이브 휴지통으로 보냅니다
      await call(`/drive/v3/files/${f.id}?fields=id`, {method: 'PATCH', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({trashed: true})});
    }
  }
  // 드라이브의 노드 파일을 모두 받습니다 → [{name, text}] (폴더가 없으면 null)
  async function pull(ownFile) {
    const fid = await folderId(false);
    if (!fid) return null;
    const out = [], seen = new Set();
    for (const f of await listFiles(fid)) {
      if (!ownFile.test(f.name) || seen.has(f.name)) continue;
      seen.add(f.name);
      out.push({name: f.name, text: await (await call(`/drive/v3/files/${f.id}?alt=media`)).text()});
    }
    return out;
  }

  return {clientId, setClientId, redirectUrl, logout, plan, push, pull};
})();
