/* 360 panorama viewer for the web (PC and phone). Same behaviour as the Quest app:
   logo -> first view dimmed to 60% with the arrive card -> Enter brightens over 1.2 s and eases in
   to the saved zoom -> look around, hotspots, bar, tray of all views, 0.3 s dip between views.
   The project's views, opening directions and hotspots come from project.js (made by Build-WebViewer.ps1). */
(function () {
  'use strict';

  var P = window.PANO_PROJECT;
  if (!P || !P.views || !P.views.length) { document.body.textContent = 'No views in project.js'; return; }

  var $ = function (id) { return document.getElementById(id); };
  var app = $('app'), stage = $('stage'), cam = $('cam'), shade = $('shade'), logo = $('logo'), loading = $('loading');
  var spotsEl = $('spots'), card = $('card'), bar = $('bar'), tray = $('tray'), trayList = $('tray-list');
  var titleBtn = $('title'), hint = $('hint');

  var V = P.views;
  var BASE_FOV = P.baseFov || 72;
  var ZOOM_OUT = P.zoomOut == null ? 14 : P.zoomOut;
  var ARRIVE_SHADE = 1 - (P.arriveExposure == null ? 0.6 : P.arriveExposure);
  var MIN_FOV = 35, MAX_FOV = 100;
  var START = Math.max(0, Math.min(V.length - 1, P.start || 0));

  var S = { index: -1, yaw: 0, pitch: 0, fov: BASE_FOV, phase: 'logo', fading: false, trayOpen: false };
  var timers = [], tweenRaf = 0, rollRaf = 0, renderQueued = false;

  function fovOf(v) { return v.fov > 0 ? v.fov : BASE_FOV; }
  function mod(a, n) { return ((a % n) + n) % n; }
  function delta(a, b) { return mod(b - a + 180, 360) - 180; }
  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
  function later(ms, fn) { var id = setTimeout(function () { timers = timers.filter(function (x) { return x !== id; }); fn(); }, ms); timers.push(id); }
  function clearTimers() { timers.forEach(clearTimeout); timers = []; }
  function stopMotion() { cancelAnimationFrame(tweenRaf); cancelAnimationFrame(rollRaf); tweenRaf = rollRaf = 0; }
  function setShade(op, ms) { shade.style.transition = 'opacity ' + (ms || 0) + 'ms ease'; shade.style.opacity = op; }

  /* ---------- the cube for each view ---------- */
  var FACE = ['f', 'r', 'b', 'l', 'u', 'd'];
  var cubes = V.map(function (v) {
    var c = document.createElement('div');
    c.className = 'cube';
    c.imgs = FACE.map(function (k) {
      var img = document.createElement('img');
      img.className = k;
      img.alt = '';
      img.draggable = false;
      img.decoding = 'async';
      c.appendChild(img);
      return img;
    });
    cam.appendChild(c);
    return c;
  });
  // Load a view's six faces (resolves when all are in and decoded). Only the view on screen is kept in
  // the page: the faces are large, and five views at once would use too much memory on a phone.
  function loadView(i) {
    var c = cubes[i];
    if (c.ready) return c.ready;
    c.ready = Promise.all(c.imgs.map(function (img, k) {
      return new Promise(function (res) {
        img.onload = img.onerror = function () { res(); };
        img.src = V[i].faces[k];
        if (img.complete) res();
      }).then(function () { return img.decode ? img.decode().catch(function () {}) : null; });
    }));
    return c.ready;
  }
  function unloadView(i) {
    if (i < 0 || i === S.index) return;
    var c = cubes[i];
    c.ready = null;
    c.imgs.forEach(function (img) { img.onload = img.onerror = null; img.removeAttribute('src'); });
  }
  // the other views are only downloaded ahead (into the browser cache), so a change of view is quick
  function preloadRest() {
    if (!window.fetch) return;
    V.forEach(function (v, i) {
      if (i === S.index) return;
      v.faces.forEach(function (url) { fetch(url, { cache: 'force-cache' }).catch(function () {}); });
    });
  }

  /* ---------- drawing ---------- */
  function persp() {
    var r = stage.getBoundingClientRect();
    var short = Math.min(r.width, r.height) || 720;
    // the zoom applies to the shorter side; on very wide screens (a phone held sideways) the width is
    // kept to at most 115 deg so the edges do not stretch
    return Math.max((short / 2) / Math.tan(S.fov * Math.PI / 360), (r.width / 2) / Math.tan(57.5 * Math.PI / 180));
  }
  function queueRender() { if (!renderQueued) { renderQueued = true; requestAnimationFrame(render); } }
  function render() {
    renderQueued = false;
    var p = persp();
    stage.style.perspective = p.toFixed(2) + 'px';
    cam.style.transform = 'translateZ(' + p.toFixed(2) + 'px) rotateX(' + S.pitch.toFixed(3) + 'deg) rotateY(' + S.yaw.toFixed(3) + 'deg)';
    placeSpots(p);
  }
  // where a spot in the picture lands on screen, or null when it is behind you
  function project(yawDeg, pitchDeg, p) {
    var r = Math.PI / 180, rel = (yawDeg - S.yaw) * r, el = pitchDeg * r;
    var x = Math.cos(el) * Math.sin(rel), y = Math.sin(el), z = Math.cos(el) * Math.cos(rel);
    var cp = Math.cos(S.pitch * r), sp = Math.sin(S.pitch * r);
    var y2 = y * cp - z * sp, z2 = y * sp + z * cp;
    if (z2 < 0.1) return null;
    var b = stage.getBoundingClientRect();
    return { x: b.width / 2 + (x / z2) * p, y: b.height / 2 - (y2 / z2) * p };
  }

  /* ---------- hotspots ---------- */
  var spotEls = [];
  function buildSpots() {
    spotsEl.textContent = '';
    spotEls = (V[S.index].hotspots || []).map(function (h) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'spot';
      var dot = document.createElement('span'); dot.className = 'dot';
      var tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = h.label;
      b.appendChild(dot); b.appendChild(tag);
      b.addEventListener('click', function (e) { e.stopPropagation(); go(h.to); });
      b.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
      spotsEl.appendChild(b);
      return { el: b, h: h };
    });
  }
  function placeSpots(p) {
    var show = S.phase === 'inside' && !S.fading;
    spotEls.forEach(function (s) {
      var q = project(s.h.yaw, s.h.pitch, p);
      var on = show && q !== null;
      s.el.classList.toggle('on', on);
      s.el.tabIndex = on ? 0 : -1;
      if (q) s.el.style.transform = 'translate(' + (q.x - 20).toFixed(1) + 'px,' + (q.y - 20).toFixed(1) + 'px)';
    });
  }

  /* ---------- views ---------- */
  function apply(i) {
    var old = S.index;
    if (old >= 0) cubes[old].classList.remove('on');
    S.index = i;
    if (old !== i) unloadView(old);
    cubes[i].classList.add('on');
    var v = V[i];
    S.yaw = v.yaw; S.pitch = v.pitch;
    if (gyro.on) gyro.resync = true;
    buildSpots();
    $('title-group').textContent = v.group || '';
    $('title-name').textContent = v.title;
    $('title-count').textContent = (i + 1) + ' / ' + V.length;
    stage.setAttribute('aria-label', '360 panorama: ' + v.title + '. Drag to look around.');
    Array.prototype.forEach.call(trayList.children, function (t, k) { t.setAttribute('aria-current', k === i ? 'true' : 'false'); });
    queueRender();
  }

  function tweenView(to, ms, ease) {
    cancelAnimationFrame(tweenRaf);
    var from = { fov: S.fov, yaw: S.yaw, pitch: S.pitch };
    var dYaw = to.yaw === undefined ? 0 : delta(S.yaw, to.yaw);
    var t0 = performance.now();
    function step(now) {
      var k = Math.min(1, (now - t0) / ms);
      var e = ease === 'out' ? 1 - Math.pow(1 - k, 4) : (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
      if (to.fov !== undefined) S.fov = from.fov + (to.fov - from.fov) * e;
      if (to.yaw !== undefined) S.yaw = mod(from.yaw + dYaw * e, 360);
      if (to.pitch !== undefined) S.pitch = from.pitch + (to.pitch - from.pitch) * e;
      render();
      tweenRaf = k < 1 ? requestAnimationFrame(step) : 0;
    }
    tweenRaf = requestAnimationFrame(step);
  }

  function setPhase(ph) {
    S.phase = ph;
    app.classList.toggle('phase-logo', ph === 'logo');
    app.classList.toggle('entered', ph === 'inside');
    queueRender();
  }

  // logo on black, then it dissolves into the first view (dimmed) and the arrive card fades in
  function intro() {
    clearTimers(); stopMotion();
    setPhase('logo');
    app.classList.remove('looking');
    logo.style.transition = 'none';
    logo.style.opacity = 0;
    card.style.transition = 'none';
    card.classList.remove('on');
    bar.classList.remove('on');
    setTray(false);
    setShade(1, 0);
    apply(START);
    S.fov = fovOf(V[START]) + ZOOM_OUT;
    render();
    var ready = Promise.all([loadView(START), new Promise(function (res) {
      if (!P.logo) return res();
      logo.onload = logo.onerror = function () { res(); };
      logo.src = P.logo;
      if (logo.complete) res();
    })]);
    var slow = setTimeout(function () { loading.classList.add('on'); }, 700);
    var begin = function () {
      clearTimeout(slow);
      loading.classList.remove('on');
      preloadRest();
      if (P.logo) {
        logo.style.transition = 'opacity 700ms ease-in-out';
        requestAnimationFrame(function () { logo.style.opacity = 1; });
        later(1900, function () {
          logo.style.transition = 'opacity 1400ms ease-in-out';
          logo.style.opacity = 0;
          arrive(1800);
        });
        later(2600, showCard);
      } else {
        arrive(1200);
        later(500, showCard);
      }
    };
    Promise.race([ready, new Promise(function (res) { setTimeout(res, 8000); })]).then(begin);
  }
  function arrive(ms) {
    apply(S.index); // faces the saved opening view where you look now
    setPhase('arrive');
    setShade(ARRIVE_SHADE, ms);
  }
  function showCard() {
    card.style.transition = 'opacity 900ms ease';
    card.classList.add('on');
    later(950, function () { card.style.transition = ''; $('enter').focus({ preventScroll: true }); });
  }

  // Enter: the card goes, the view brightens over 1.2 s and eases in to its saved zoom. If you have turned
  // more than 20 deg away from the opening view, it turns back first during a quick dim.
  function enter() {
    if (S.phase !== 'arrive' || S.fading) return;
    autoMotion();
    autoFullscreen();
    var v = V[S.index];
    cancelAnimationFrame(rollRaf);
    card.classList.remove('on');
    if (Math.abs(delta(S.yaw, v.yaw)) > 20 && !gyro.on) {
      S.fading = true;
      setShade(0.8, 150);
      later(170, function () { S.yaw = v.yaw; S.pitch = v.pitch; render(); later(40, brighten); });
    } else {
      brighten();
    }
  }
  function brighten() {
    S.fading = false;
    setPhase('inside');
    bar.classList.add('on');
    setShade(0, 1200);
    tweenView({ fov: fovOf(V[S.index]) }, 1200, 'inOut');
    if (!hint.dataset.done) { hint.classList.add('on'); later(4500, function () { hint.classList.remove('on'); }); }
  }

  // a view change dips to black for 0.3 s and opens the new view at its saved direction
  function go(i) {
    if (S.phase !== 'inside' || S.fading) return;
    if (i === S.index) { setTray(false); return; }
    stopMotion();
    S.fading = true;
    setTray(false);
    setShade(1, 300);
    queueRender();
    loadView(i).then(function () {
      later(320, function () {
        apply(i);
        S.fov = fovOf(V[i]);
        render();
        later(60, function () {
          setShade(0, 300);
          later(320, function () { S.fading = false; queueRender(); });
        });
      });
    });
  }

  // back to the first view and the arrive card (B on the headset)
  function home() {
    if (S.phase === 'logo') return;
    clearTimers(); stopMotion();
    S.fading = true;
    setTray(false);
    card.classList.remove('on');
    bar.classList.remove('on');
    setShade(1, 300);
    var ready = loadView(START);
    later(320, function () {
      ready.then(function () {
        apply(START);
        S.fov = fovOf(V[START]) + ZOOM_OUT;
        setPhase('arrive');
        render();
        later(60, function () {
          setShade(ARRIVE_SHADE, 300);
          card.classList.add('on');
          later(320, function () { S.fading = false; });
        });
      });
    });
  }

  /* ---------- tray ---------- */
  V.forEach(function (v, i) {
    var t = document.createElement('button');
    t.type = 'button';
    t.className = 'tile';
    var img = document.createElement('img'); img.src = v.thumb; img.alt = ''; img.loading = 'lazy';
    var g = document.createElement('span'); g.className = 'g'; g.textContent = v.group || '';
    var n = document.createElement('span'); n.className = 't'; n.textContent = v.title;
    t.appendChild(img); t.appendChild(g); t.appendChild(n);
    t.addEventListener('click', function () { go(i); });
    trayList.appendChild(t);
  });
  function setTray(open) {
    S.trayOpen = open;
    tray.classList.toggle('on', open);
    titleBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      var cur = trayList.children[S.index];
      if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest', inline: 'center' });
    }
  }

  /* ---------- looking around: drag, inertia, pinch and wheel zoom, keys ---------- */
  var pointers = new Map(), drag = null, pinch = null;
  stage.addEventListener('pointerdown', function (e) {
    if (S.phase === 'logo') return;
    cancelAnimationFrame(rollRaf);
    if (S.trayOpen) setTray(false);
    try { stage.setPointerCapture(e.pointerId); } catch (err) {}
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      var pts = Array.from(pointers.values());
      pinch = { d: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y), fov: S.fov };
      drag = null;
    } else if (pointers.size === 1) {
      drag = { x: e.clientX, y: e.clientY, yaw: S.yaw, pitch: S.pitch, off: gyro.offset, poff: gyro.pOffset, samples: [{ t: performance.now(), yaw: S.yaw, pitch: S.pitch }] };
      stage.classList.add('dragging');
    }
    hideHint();
  });
  stage.addEventListener('pointermove', function (e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pointers.size >= 2) {
      var pts = Array.from(pointers.values());
      var d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      if (d > 0) { S.fov = clamp(pinch.fov * pinch.d / d, MIN_FOV, MAX_FOV); queueRender(); }
      return;
    }
    if (!drag) return;
    looking();
    var r = stage.getBoundingClientRect();
    var degPerPx = S.fov / Math.min(r.width, r.height);
    var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (gyro.on) {
      // with motion on, the finger still turns the view: it shifts where the phone's direction points
      gyro.offset = drag.off - dx * degPerPx;
      gyro.pOffset = clamp(drag.poff + dy * degPerPx, -80, 80);
      if (gyro.last) onOrient(gyro.last);
    } else {
      S.yaw = mod(drag.yaw - dx * degPerPx, 360);
      S.pitch = clamp(drag.pitch + dy * degPerPx, -85, 85);
      drag.samples.push({ t: performance.now(), yaw: drag.yaw - dx * degPerPx, pitch: S.pitch });
      if (drag.samples.length > 6) drag.samples.shift();
    }
    queueRender();
  });
  function endPointer(e) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size > 0) return;
    stage.classList.remove('dragging');
    var d = drag; drag = null;
    if (!d || gyro.on || d.samples.length < 2) return;
    var a = d.samples[0], b = d.samples[d.samples.length - 1], dt = b.t - a.t;
    if (dt <= 0 || performance.now() - b.t > 80) return;
    if (dt < 16) return; // a jump, not a flick
    var vy = clamp((b.yaw - a.yaw) / dt, -0.4, 0.4), vp = clamp((b.pitch - a.pitch) / dt, -0.2, 0.2) * 0.6, last = performance.now();
    function roll(now) {
      var step = now - last; last = now;
      var k = Math.pow(0.94, step / 16);
      vy *= k; vp *= k;
      S.yaw = mod(S.yaw + vy * step, 360);
      S.pitch = clamp(S.pitch + vp * step, -85, 85);
      render();
      rollRaf = Math.abs(vy) + Math.abs(vp) > 0.002 ? requestAnimationFrame(roll) : 0;
    }
    if (Math.abs(vy) + Math.abs(vp) > 0.01) rollRaf = requestAnimationFrame(roll);
  }
  stage.addEventListener('pointerup', endPointer);
  stage.addEventListener('pointercancel', endPointer);

  app.addEventListener('wheel', function (e) {
    if (S.phase === 'logo') return;
    if (e.target.closest && e.target.closest('#tray')) return;
    e.preventDefault();
    cancelAnimationFrame(tweenRaf);
    S.fov = clamp(S.fov * Math.exp(e.deltaY * 0.0012), MIN_FOV, MAX_FOV);
    queueRender();
  }, { passive: false });

  document.addEventListener('keydown', function (e) {
    if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
    var step = 5;
    if (e.key === 'Home') { home(); e.preventDefault(); }
    else if (e.key === 'Escape' && S.trayOpen) setTray(false);
    else if (S.phase === 'logo') return;
    else if (e.key === 'ArrowLeft') { S.yaw = mod(S.yaw - step, 360); queueRender(); }
    else if (e.key === 'ArrowRight') { S.yaw = mod(S.yaw + step, 360); queueRender(); }
    else if (e.key === 'ArrowUp') { S.pitch = clamp(S.pitch + step, -85, 85); queueRender(); e.preventDefault(); }
    else if (e.key === 'ArrowDown') { S.pitch = clamp(S.pitch - step, -85, 85); queueRender(); e.preventDefault(); }
    else if (e.key === '+' || e.key === '=') { S.fov = clamp(S.fov - 5, MIN_FOV, MAX_FOV); queueRender(); }
    else if (e.key === '-') { S.fov = clamp(S.fov + 5, MIN_FOV, MAX_FOV); queueRender(); }
  });

  function hideHint() { hint.dataset.done = '1'; hint.classList.remove('on'); }

  // while the view is being turned, the bar fades back; it comes up again a moment after you stop
  var lookTimer = 0;
  function looking() {
    if (S.phase !== 'inside') return;
    app.classList.add('looking');
    clearTimeout(lookTimer);
    lookTimer = setTimeout(function () { app.classList.remove('looking'); }, 1400);
  }

  /* ---------- full screen ---------- */
  var root = document.documentElement;
  var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var standalone = window.navigator.standalone === true || (window.matchMedia && window.matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches);
  // iPhone Safari cannot go full screen from a page; opened from the Home Screen it fills the screen
  if (isIOS && !standalone) $('ios-tip').hidden = false;
  // Android: the tap on Enter also goes full screen and holds the view sideways
  function autoFullscreen() {
    var touchDevice = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    if (!touchDevice || standalone || document.fullscreenElement || document.webkitFullscreenElement) return;
    var req = root.requestFullscreen || root.webkitRequestFullscreen;
    if (!req) return;
    try {
      var p = req.call(root, { navigationUI: 'hide' });
      if (p && p.then) p.then(function () {
        if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(function () {});
      }).catch(function () {});
    } catch (err) {}
  }

  /* ---------- phone: move the phone to look around ---------- */
  var gyro = { on: false, offset: 0, pOffset: 0, resync: false, last: null };
  var motionBtn = $('motion');
  var touch = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  if (!('DeviceOrientationEvent' in window) || !touch) motionBtn.hidden = true;
  function deviceView(e) {
    // device orientation -> where the back camera points (heading, up/down), as three.js does it
    var r = Math.PI / 180;
    var x = (e.beta || 0) * r, y = (e.alpha || 0) * r, z = -(e.gamma || 0) * r;
    var c1 = Math.cos(x / 2), c2 = Math.cos(y / 2), c3 = Math.cos(z / 2), s1 = Math.sin(x / 2), s2 = Math.sin(y / 2), s3 = Math.sin(z / 2);
    var q = [s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3, c1 * c2 * s3 - s1 * s2 * c3, c1 * c2 * c3 + s1 * s2 * s3];
    q = qmul(q, [-Math.SQRT1_2, 0, 0, Math.SQRT1_2]);
    var o = ((screen.orientation && screen.orientation.angle) || window.orientation || 0) * r;
    q = qmul(q, [0, 0, Math.sin(-o / 2), Math.cos(-o / 2)]);
    var f = qrot(q, [0, 0, -1]);
    return { yaw: Math.atan2(f[0], -f[2]) / r, pitch: Math.asin(clamp(f[1], -1, 1)) / r };
  }
  function qmul(a, b) {
    return [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
      a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
      a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
      a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
  }
  function qrot(q, v) {
    var x = q[0], y = q[1], z = q[2], w = q[3];
    var ix = w * v[0] + y * v[2] - z * v[1], iy = w * v[1] + z * v[0] - x * v[2], iz = w * v[2] + x * v[1] - y * v[0], iw = -x * v[0] - y * v[1] - z * v[2];
    return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
  }
  function onOrient(e) {
    if (!gyro.on || e.alpha == null) return;
    gyro.last = { alpha: e.alpha, beta: e.beta, gamma: e.gamma };
    var d = deviceView(e);
    if (gyro.resync) { gyro.offset = S.yaw - d.yaw; gyro.pOffset = 0; gyro.resync = false; }
    var ny = mod(d.yaw + gyro.offset, 360), np = clamp(d.pitch + gyro.pOffset, -85, 85);
    if (Math.abs(delta(S.yaw, ny)) + Math.abs(np - S.pitch) > 0.4) looking();
    S.yaw = ny;
    S.pitch = np;
    queueRender();
  }
  function setGyro(on) {
    gyro.on = on;
    gyro.resync = true;
    motionBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    if (on) { cancelAnimationFrame(rollRaf); window.addEventListener('deviceorientation', onOrient); }
    else window.removeEventListener('deviceorientation', onOrient);
  }
  // iPhone asks for permission (it must be asked from a tap); Android needs none
  function askMotion() {
    var D = window.DeviceOrientationEvent;
    if (D && typeof D.requestPermission === 'function') {
      D.requestPermission().then(function (r) { if (r === 'granted') setGyro(true); }).catch(function () {});
    } else {
      setGyro(true);
    }
  }
  // on a phone, the tap on Enter turns motion on (iPhone shows its Allow popup first); the motion
  // button turns it off and on again
  var motionAsked = false;
  function autoMotion() {
    if (motionAsked || motionBtn.hidden || gyro.on) return;
    motionAsked = true;
    askMotion();
  }
  motionBtn.addEventListener('click', function () {
    if (gyro.on) setGyro(false); else askMotion();
  });

  /* ---------- buttons ---------- */
  $('enter').addEventListener('click', enter);
  $('prev').addEventListener('click', function () { go((S.index + V.length - 1) % V.length); });
  $('next').addEventListener('click', function () { go((S.index + 1) % V.length); });
  titleBtn.addEventListener('click', function () { if (S.phase === 'inside' && !S.fading) setTray(!S.trayOpen); });
  $('home').addEventListener('click', home);
  $('replay').addEventListener('click', function () { S.fading = false; intro(); });
  var fsBtn = $('fullscreen');
  if (!(root.requestFullscreen || root.webkitRequestFullscreen) || standalone) fsBtn.hidden = true;
  fsBtn.addEventListener('click', function () {
    var fs = document.fullscreenElement || document.webkitFullscreenElement;
    if (fs) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    else (root.requestFullscreen || root.webkitRequestFullscreen).call(root);
  });

  /* ---------- text and start ---------- */
  document.title = P.name ? P.name + ' | 360' : '360 Viewer';
  $('card-top').textContent = P.topLine || '';
  $('card-name').textContent = P.name || '';
  $('card-sub').textContent = P.subtitle || '';
  if (P.logo) logo.alt = (P.name || 'Project') + ' logo';
  window.addEventListener('resize', queueRender);
  intro();
})();
