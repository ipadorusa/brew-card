// 브루 카드: 주소 # 뒤의 레시피(FORMAT.md v1)를 풀어 폰용 카드로 보여준다. index.html이 읽는다.

import { isNum as num, cardOf, scaleCard, zp6Of } from './brew-core.js';
import { registerSW } from './pwa.js';

const $ = (id) => document.getElementById(id);
const KEY = 'brewcard.recent';
const MAX_RECENT = 10;

// ---------- 디코드 (FORMAT.md v1) ----------
function b64urlBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
async function decodePayload(p) {
  const stream = new Blob([b64urlBytes(p)]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return JSON.parse(await new Response(stream).text());
}
const str = (v) => (v == null ? '' : String(v));

// ---------- 표기 ----------
const r1 = (x) => String(Math.round(x * 10) / 10);
function grindText(c) {
  const a = Array.isArray(c) ? c : [c, c];
  if (!num(a[0]) || !num(a[1])) return '';
  const f = (fn) => (a[0] === a[1] ? fn(a[0]) : fn(a[0]) + '~' + fn(a[1]));
  return `코만단테 ${f(String)}클릭 ≈ ${f((x) => r1(x * 30))}µm (ZP6\u00a0${f(zp6Of)})`; // \u00a0: 이름과 값 사이에서 줄이 안 바뀌게
}
function waterText(o) {
  const parts = [];
  if (num(o.w)) parts.push((num(o.i) || o.t === 'ICE' ? '뜨거운 물 ' : '물 ') + o.w + 'g');
  if (num(o.i)) parts.push('얼음 ' + o.i + 'g');
  if (num(o.p)) parts.push('바이패스 ' + o.p + 'g');
  return parts.join(' + ');
}
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
const join = (a, sep) => a.filter(Boolean).join(sep);

// ---------- 최근 카드 ----------
function loadRecent() { try { const a = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
function saveRecent(h, o) {
  try {
    const list = loadRecent().filter((x) => x && x.h !== h);
    list.unshift({ h, b: str(o.b), r: str(o.r), d: str(o.d), t: str(o.t), ts: Date.now() });
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX_RECENT)));
  } catch (e) { /* 저장 불가(사생활 보호 모드 등) */ }
}

// ---------- 화면 ----------
let card = null, cur = -1, routeToken = 0;
function show(id) { for (const s of ['home', 'err', 'card']) $(s).hidden = s !== id; window.scrollTo(0, 0); }

async function route() {
  const token = ++routeToken;
  const h = location.hash.replace(/^#/, '').replace(/\s+/g, '');
  if (!h) { card = null; renderHome(); return; }
  const dot = h.indexOf('.');
  const ver = dot > 0 ? h.slice(0, dot) : '';
  if (ver !== '1') {
    return showErr(/^\d+$/.test(ver)
      ? `이 카드는 새 형식(v${ver})이라 지금 화면에서는 열 수 없어요. 인터넷에 연결된 상태에서 잠시 뒤 다시 열어 주세요.`
      : '주소 형식이 맞지 않아요. QR을 다시 스캔해 주세요.');
  }
  if (typeof DecompressionStream === 'undefined') {
    return showErr('이 브라우저는 카드를 풀 수 없어요. iOS 17 이상의 Safari나 최신 브라우저에서 열어 주세요.');
  }
  let c;
  try { c = cardOf(await decodePayload(h.slice(dot + 1))); }
  catch (e) { if (token === routeToken) showErr('카드를 읽지 못했어요. 주소가 잘렸을 수 있어요. QR을 다시 스캔해 주세요.'); return; }
  if (token !== routeToken) return;
  saveRecent(h, c.o);
  openCard(c);
}
function showErr(msg) { card = null; $('errMsg').textContent = msg; document.title = '브루 카드'; show('err'); }

function renderHome() {
  document.title = '브루 카드';
  const list = loadRecent(), ul = $('recent');
  ul.textContent = '';
  for (const x of list) {
    const li = el('li'), a = el('a');
    a.href = '#' + x.h;
    a.append(el('b', null, join([x.b, x.r], ' · ') || '이름 없는 카드'), el('span', null, join([x.d, x.t], ' · ')));
    li.append(a); ul.append(li);
  }
  $('homeEmpty').hidden = list.length > 0;
  $('homeList').hidden = list.length === 0;
  show('home');
}

function openCard(c) {
  card = c; cur = -1; dose = c.o.g;
  const o = c.o;
  document.title = join([o.b, join([o.d, o.t], ' ')], ' · ') || '브루 카드';
  $('hTitle').textContent = join([o.b, o.r], ' · ');
  $('hSub').textContent = join([o.d, o.t], ' · ') + (o.id ? `  (레시피 ${o.id})` : '');
  $('tt').textContent = o.tt ? '총 시간 ' + o.tt : '';
  $('tt').hidden = !o.tt;
  $('adj').textContent = o.a ? '첫 잔 후 조정: ' + o.a : '';
  $('live').textContent = '';
  draw();
  show('card');
  mark(-1);
}

// ---------- 원두량 바꾸기 (계산은 brew-core.js scaleCard) ----------
const G_MIN = 8, G_MAX = 20;
let dose = null, shown = null;
function setDose(g) {
  if (!card || !num(g) || g === dose) return;
  dose = g;
  const k = cur;
  draw();
  mark(k);
  $('live').textContent = `원두 ${g}g 기준으로 바꿨어요.`;
}
// 14.5g 같은 원래 값에서도 정수 g으로 움직이고, 범위(8~20g, 원래 값이 밖이면 그 값까지)를 넘지 않는다.
const gLo = () => Math.min(G_MIN, card.o.g), gHi = () => Math.max(G_MAX, card.o.g);
$('bMinus').addEventListener('click', () => card && setDose(Math.max(gLo(), Math.ceil(dose) - 1)));
$('bPlus').addEventListener('click', () => card && setDose(Math.min(gHi(), Math.floor(dose) + 1)));
$('bReset').addEventListener('click', () => setDose(card && card.o.g));

function draw() {
  const c = shown = scaleCard(card, dose), o = c.o, g0 = card.o.g, changed = num(g0) && dose !== g0;
  const sc = $('scale');
  sc.hidden = !num(g0);
  if (num(g0)) {
    $('gOut').textContent = dose + 'g';
    $('bMinus').disabled = dose <= gLo();
    $('bPlus').disabled = dose >= gHi();
    $('bReset').hidden = !changed;
  }
  const sn = $('scaleNote');
  sn.hidden = !changed;
  sn.textContent = changed
    ? `원래 ${g0}g 레시피를 ${dose}g에 맞춰 물${num(o.i) ? '·얼음' : ''}을 비율대로 ${dose < g0 ? '줄였어요' : '늘렸어요'}. 시각·분쇄·온도는 그대로예요.`
      + (Math.abs(dose - g0) >= 3 ? ' 3g 넘게 바꾸면 추출 시간이 달라질 수 있어요. 맛을 보고 분쇄를 1클릭씩 고쳐 주세요.' : '')
    : '';

  const spec = $('spec'); spec.textContent = '';
  const doseEl = el('div', 'dose' + (changed ? ' chg' : ''), num(o.g) ? o.g + 'g' : '—'); doseEl.append(el('small', null, '원두'));
  const gp = el('p', 'grind');
  const gt = (o.c != null && grindText(o.c)) || '분쇄 정보 없음', cut = gt.indexOf(' (');
  if (cut > 0) gp.append(el('span', null, gt.slice(0, cut)), ' ', el('span', null, gt.slice(cut + 1))); else gp.textContent = gt;
  spec.append(doseEl, gp,
    el('p', null, join([num(o.T) ? o.T + '℃' : '', o.ra ? '비율 ' + o.ra : ''], ' · ')));
  const row = el('div', 'row'), wt = waterText(o);
  if (wt) { const s = el('span'); s.append(el('b', null, wt)); row.append(s); }
  if (o.f) row.append(el('span', null, '필터 ' + o.f));
  if (row.childNodes.length) spec.append(row);

  const ol = $('steps'); ol.textContent = '';
  let prev = 0;
  c.steps.forEach((s, k) => {
    const li = el('li'), b = el('button', 'step');
    b.type = 'button'; b.dataset.k = k;
    b.append(el('span', 'tm', s.label || '—'));
    if (s.valve != null) b.append(el('span', 'badge vb ' + (s.valve ? 'o' : 'c'), s.valve ? '열림' : '닫힘'));
    b.append(el('span', 'act', s.act));
    const g = el('span', 'g', s.g == null ? '' : s.g + 'g');
    if (s.g != null && prev != null && s.g > prev && k > 0) g.append(el('small', null, '+' + (s.g - prev) + 'g'));
    b.append(g);
    b.setAttribute('aria-label', join([s.label, s.valve === 0 ? '밸브 닫힘' : s.valve === 1 ? '밸브 열림' : '', s.g != null ? '누적 ' + s.g + 'g' : '', s.act], ', '));
    li.append(b); ol.append(li);
    prev = s.g;
  });
}

// 단계 표시: 다른 단계를 누르면 그 단계로, 지금 단계를 다시 누르면 다음 단계로 (마지막이면 해제)
function mark(k) {
  cur = k;
  document.querySelectorAll('#steps .step').forEach((b, i) => {
    b.classList.toggle('cur', i === cur);
    if (i === cur) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
  });
  const s = shown && shown.steps[cur];
  $('live').textContent = s ? `${cur + 1}단계: ${join([s.label, s.g != null ? s.g + 'g' : '', s.act], ', ')}` : '';
}
$('steps').addEventListener('click', (e) => {
  const b = e.target.closest('.step');
  if (!b || !card) return;
  const k = +b.dataset.k;
  if (k !== cur) mark(k);
  else {
    const n = k + 1 < card.steps.length ? k + 1 : -1;
    mark(n);
    if (n >= 0) document.querySelectorAll('#steps .step')[n].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
});

// ---------- 화면 켜두기 (선택) ----------
let wl = null, wantWake = false;
function note(msg) { const n = $('note'); n.textContent = msg; n.hidden = !msg; }
async function wake() {
  try {
    if (!wl || wl.released) wl = await navigator.wakeLock.request('screen');
    if (!wantWake) { releaseWake(); return; }
    note('');
  } catch (e) { note('화면 켜두기를 켜지 못했어요. 저전력 모드라면 꺼 주세요.'); }
}
function releaseWake() { const w = wl; wl = null; if (w && !w.released) w.release().catch(() => {}); }
if ('wakeLock' in navigator) {
  const bw = $('bWake');
  bw.hidden = false;
  bw.addEventListener('click', () => {
    wantWake = !wantWake;
    bw.setAttribute('aria-pressed', String(wantWake));
    if (wantWake) wake(); else { releaseWake(); note(''); }
  });
  document.addEventListener('visibilitychange', () => { if (wantWake && document.visibilityState === 'visible') wake(); });
}

// ---------- 연결 ----------
$('bClear').addEventListener('click', () => { try { localStorage.removeItem(KEY); } catch (e) {} renderHome(); });
document.querySelectorAll('a.home').forEach((a) => a.addEventListener('click', (e) => {
  e.preventDefault(); history.pushState(null, '', location.pathname + location.search); route();
}));
window.addEventListener('hashchange', route);
registerSW();
route();
