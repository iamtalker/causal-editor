// 터치 조작 어댑터 (안드로이드 전용). PC 화면과 index.html의 편집 코드는 바꾸지 않습니다.
//
// 문제 1 (노드가 안 움직임): 손가락이 조금 움직이기 전에는 브라우저가 화면을 스크롤하려고 손가락 동작을 가져갑니다.
//   그러면 앱에는 touchcancel만 전달되고 노드 끌기가 끊깁니다.
//   해결: #stage에 touch-action:none을 주어 브라우저가 스크롤하지 않게 하고, 손가락이 닿은 순간부터 막습니다.
// 문제 2 (편집기는 노드를 끌 때마다 전체를 다시 그림): 끄는 동안에는 노드의 위치(transform)만 바꾸고,
//   손을 떼면 저장하고 다시 그립니다. 다시 그리면 손가락이 잡고 있던 요소가 사라지기 때문입니다.
// 추가: 두 손가락으로 확대·축소(핀치), 빈 곳 두 번 탭으로 노드 추가, 한 손가락 화면 밀기.
//  - 탭(움직임 없이 뗌): 원래 마우스 클릭 흐름(선택, 화살표 연결 등)을 그대로 실행합니다.
(function () {
  const MOVE_SLOP = 10;          // 이 거리(px)보다 적게 움직이면 탭으로 봅니다.
  const DOUBLE_TAP_MS = 320, DOUBLE_TAP_PX = 28;
  const MIN_ZOOM = 0.2, MAX_ZOOM = 3;   // index.html의 휠 확대 범위와 같습니다.

  const style = document.createElement('style');
  style.textContent = '#stage{touch-action:none}';
  (document.head || document.documentElement).appendChild(style);

  let gesture = null;            // 한 손가락 동작: node / pan / tap
  let pinch = null;              // 두 손가락 확대·축소 상태
  let busy = false;              // 두 손가락 동작이 끝난 뒤, 손가락을 모두 뗄 때까지 새 동작을 막습니다.
  let lastTap = null;            // 직전 탭 (두 번 탭 확인용)

  const stageEl = () => document.getElementById('stage');
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  const stageXY = (cx, cy, stage) => { const r = stage.getBoundingClientRect(); return {x: cx - r.left, y: cy - r.top}; };
  const findNode = (id) => S.nodes.find(n => String(n.id) === String(id));

  const fire = (type, x, y, target) => {
    target.dispatchEvent(new MouseEvent(type, {
      bubbles: true, cancelable: true, view: window,
      clientX: x, clientY: y, button: 0, buttons: type === 'mouseup' ? 0 : 1
    }));
  };

  // 두 손가락: 손가락 사이 가운데 점 아래의 그래프 위치를 그대로 두고 확대율만 바꿉니다.
  function startPinch(touches) {
    const stage = stageEl(), [a, b] = touches;
    const m = stageXY((a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2, stage);
    pinch = {
      d0: Math.max(dist(a, b), 1), z0: zoom,
      wx: (stage.scrollLeft + m.x) / zoom + viewMinX,
      wy: (stage.scrollTop + m.y) / zoom + viewMinY
    };
  }
  function movePinch(touches) {
    const stage = stageEl(), [a, b] = touches;
    const m = stageXY((a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2, stage);
    zoom = clamp(pinch.z0 * dist(a, b) / pinch.d0, MIN_ZOOM, MAX_ZOOM);
    render();
    stage.scrollLeft = (pinch.wx - viewMinX) * zoom - m.x;
    stage.scrollTop = (pinch.wy - viewMinY) * zoom - m.y;
  }
  function endPinch() {
    pinch = null;
    busy = true;
    render();
  }

  // 한 손가락으로 노드를 끌던 중이었다면 지금까지의 위치를 저장하고 다시 그립니다.
  function finishGesture() {
    const g = gesture;
    gesture = null;
    if (g && g.kind === 'node' && g.moved) { save(); render(); }
  }

  window.addEventListener('touchstart', (e) => {
    if (e.touches.length >= 2) {
      if (!pinch) {
        finishGesture();
        startPinch(e.touches);
      }
      return;
    }
    if (busy || pinch || e.touches.length !== 1) return;
    const t = e.touches[0];
    const target = e.target;
    if (!target || !target.closest || !target.closest('#stage')) { gesture = null; return; }
    const ng = target.closest('[data-node]');
    const stage = stageEl();
    if (ng) {
      const n = findNode(ng.dataset.node);
      if (!n) { gesture = null; return; }
      const p = svgPoint({clientX: t.clientX, clientY: t.clientY});
      gesture = {kind: 'node', el: ng, node: n, dx: p.x - n.x, dy: p.y - n.y,
        x0: t.clientX, y0: t.clientY, moved: false, target};
    } else if (!target.closest('[data-edge]')) {
      gesture = {kind: 'pan', stage, left: stage.scrollLeft, top: stage.scrollTop,
        x0: t.clientX, y0: t.clientY, moved: false, target};
    } else {
      gesture = {kind: 'tap', x0: t.clientX, y0: t.clientY, moved: false, target};
    }
  }, {passive: true});

  window.addEventListener('touchmove', (e) => {
    if (pinch) {
      if (e.touches.length >= 2) { e.preventDefault(); movePinch(e.touches); }
      return;
    }
    if (!gesture) return;
    // 움직이기 전부터 막습니다. 그래야 브라우저가 스크롤을 가져가 touchcancel이 오지 않습니다.
    e.preventDefault();
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    if (!gesture.moved && Math.hypot(t.clientX - gesture.x0, t.clientY - gesture.y0) < MOVE_SLOP) return;
    gesture.moved = true;
    if (gesture.kind === 'node') {
      const p = svgPoint({clientX: t.clientX, clientY: t.clientY});
      gesture.node.x = Math.max(0, p.x - gesture.dx);
      gesture.node.y = Math.max(0, p.y - gesture.dy);
      gesture.el.setAttribute('transform', `translate(${gesture.node.x},${gesture.node.y})`);
    } else if (gesture.kind === 'pan') {
      gesture.stage.scrollLeft = gesture.left - (t.clientX - gesture.x0);
      gesture.stage.scrollTop = gesture.top - (t.clientY - gesture.y0);
    }
  }, {passive: false});

  window.addEventListener('touchend', (e) => {
    if (pinch) {
      if (e.touches.length < 2) endPinch();
      if (e.touches.length === 0) busy = false;
      return;
    }
    if (e.touches.length === 0) busy = false;
    if (busy) return;
    const g = gesture;
    if (!g || e.touches.length > 0) { gesture = null; return; }
    gesture = null;
    e.preventDefault();          // 손을 뗀 뒤 브라우저가 따로 만드는 클릭을 막습니다.
    const t = e.changedTouches[0];
    if (g.moved && g.kind === 'node') {
      save();                    // 새 위치 저장 (실행 취소 기록 포함)
      render();                  // 화살표와 화면 전체를 다시 그립니다
      return;
    }
    if (g.moved) return;         // 화면 밀기 끝
    // 빈 곳 두 번 탭: 노드 추가 (PC의 더블클릭과 같습니다)
    if (g.kind === 'pan') {
      const now = Date.now();
      if (lastTap && now - lastTap.at < DOUBLE_TAP_MS && Math.hypot(t.clientX - lastTap.x, t.clientY - lastTap.y) < DOUBLE_TAP_PX) {
        lastTap = null;
        svg.dispatchEvent(new MouseEvent('dblclick', {bubbles: true, cancelable: true, view: window,
          clientX: t.clientX, clientY: t.clientY}));
        return;
      }
      lastTap = {at: now, x: t.clientX, y: t.clientY};
    } else {
      lastTap = null;
    }
    // 탭: 원래 마우스 흐름을 실행합니다. 이 시점에는 아직 그래프를 다시 그리지 않았으므로 대상이 남아 있습니다.
    fire('mousedown', t.clientX, t.clientY, g.target);
    fire('mouseup', t.clientX, t.clientY, window);
  }, {passive: false});

  window.addEventListener('touchcancel', (e) => {
    gesture = null;
    if (pinch && e.touches.length < 2) endPinch();
    if (e.touches.length === 0) busy = false;
  }, {passive: true});
})();
