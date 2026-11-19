// 원두 노트: 비공개 저장소(my-coffe-recipe)의 beans/·recipes/를 GitHub API로 읽어 보여준다.
// 이 파일과 페이지는 공개 저장소에 올라가지만 내용은 없다. 내용은 이 기기에 저장한 읽기 전용 토큰으로만 읽는다.
// 개발용: library.html?local=../ 이면 GitHub 대신 같은 서버의 ../beans/, ../recipes/를 읽는다.

import { tablesIn, splitRow, clean, parseBeanText, NON_BEAN, roastAge, saleStatus, zp6Of } from './brew-core.js';
import { registerSW } from './pwa.js';
import { recipeEvidence, bagHistory, bagAge, dripperChoice } from './bean-details.js';

const KEY = 'coffee-lib:';
const DEFAULT_REPO = 'ipadorusa/my-coffe-recipe';
const DOC_NAMES = {
  'recipes/v60-switch.md': 'V60 Switch 레시피',
  'recipes/orea.md': 'OREA O1 레시피',
  'recipes/graycano.md': '그레이카노 레시피',
  'recipes/v60.md': 'V60 레시피',
  'recipes/solo.md': 'SOLO 레시피',
  'recipes/blends-and-bean-guide.md': '블렌드 · 원두 가이드',
  'recipes/REVIEW.md': '브루잉 챔피언 검토',
  'beans/TEMPLATE.md': '원두 파일 양식',
};

const $ = (id) => document.getElementById(id);
const view = $('view');

// ---------- 저장 ----------

function load(k, fallback = null) {
  try { const v = localStorage.getItem(KEY + k); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
}
function save(k, v) {
  try { localStorage.setItem(KEY + k, JSON.stringify(v)); return true; } catch { return false; }
}
function drop(k) { try { localStorage.removeItem(KEY + k); } catch { /* 없음 */ } }
function cacheKeys() {
  try { return Object.keys(localStorage).filter((k) => k.startsWith(KEY + 'blob:')); } catch { return []; }
}

const cfg = () => ({ repo: DEFAULT_REPO, branch: 'main', token: '', ...load('cfg', {}) });

// ---------- 데이터 소스 ----------

class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

const localBase = (() => {
  const v = new URLSearchParams(location.search).get('local');
  return v && /^(\.\.\/|\.\/|\/)/.test(v) ? (v.endsWith('/') ? v : v + '/') : null;
})();

// 시험용: localhost에서만 ?api=/경로 로 같은 서버의 가짜 API를 쓴다. 공개 사이트에서는 늘 api.github.com.
const apiBase = (() => {
  const v = new URLSearchParams(location.search).get('api');
  return v && v.startsWith('/') && /^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? v.replace(/\/$/, '') : 'https://api.github.com';
})();

async function gh(path, body, method = body ? 'POST' : 'GET') {
  const { token } = cfg();
  const res = await fetch(`${apiBase}${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  if (!res.ok) {
    const msg = res.status === 401 ? '토큰이 맞지 않거나 만료됐어요.'
      : res.status === 404 ? '저장소를 찾을 수 없어요. 토큰에 이 저장소 읽기 권한이 있는지 확인해 주세요.'
      : res.status === 403 ? 'GitHub이 요청을 막았어요(권한 또는 요청 한도). 잠시 뒤 다시 해 주세요.'
      : `GitHub 응답 ${res.status}`;
    throw new HttpError(res.status, msg);
  }
  return res.status === 204 ? null : res.json();
}

// 파일 목록: [{path, sha}] (beans/*.md, recipes/*.md)
async function fetchTree() {
  if (localBase) {
    const files = [];
    for (const dir of ['beans', 'recipes']) {
      const html = await (await fetch(`${localBase}${dir}/`, { cache: 'no-store' })).text();
      for (const m of html.matchAll(/href="([^"?#/]+\.md)"/g)) {
        const name = decodeURIComponent(m[1]);
        files.push({ path: `${dir}/${name}`, sha: `local:${dir}/${name}` });
      }
    }
    return { sha: `local:${Date.now()}`, files };
  }
  const { repo, branch } = cfg();
  const t = await gh(`/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
  const files = t.tree
    .filter((x) => x.type === 'blob' && /^(beans|recipes)\/[^/]+\.md$/.test(x.path))
    .map((x) => ({ path: x.path, sha: x.sha }));
  return { sha: t.sha, files };
}

function b64ToText(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
  return new TextDecoder().decode(bytes);
}

const pending = new Map();
async function readFile(path) {
  const f = state.tree?.files.find((x) => x.path === path);
  if (!f) throw new HttpError(404, `파일이 없어요: ${path}`);
  if (localBase) return (await fetch(`${localBase}${path}`, { cache: 'no-store' })).text();
  const hit = load(`blob:${f.sha}`);
  if (hit != null) return hit;
  if (!pending.has(f.sha)) {
    pending.set(f.sha, (async () => {
      const { repo, token } = cfg();
      const b = await gh(`/repos/${repo}/git/blobs/${f.sha}`);
      const text = b.encoding === 'base64' ? b64ToText(b.content) : b.content;
      if (cfg().repo === repo && cfg().token === token) save(`blob:${f.sha}`, text);
      return text;
    })().finally(() => pending.delete(f.sha)));
  }
  return pending.get(f.sha);
}

// ---------- 상태와 동기화 ----------

const state = { tree: load('tree'), syncing: false, caching: false, error: null };
let prefetchRun = 0;
// route()가 화면을 바꿀 때마다 올린다. 파일을 기다리는 사이 다른 화면으로 옮겼으면 늦게 온 결과는 버린다.
let screen = 0;

function setStatus() {
  const s = $('status');
  s.className = 'status';
  if (localBase) { s.textContent = `개발 모드: ${localBase} 에서 읽는 중`; return; }
  if (state.syncing) { s.textContent = 'GitHub에서 받는 중…'; return; }
  const at = state.tree?.at ? new Date(state.tree.at) : null;
  const when = at ? at.toLocaleString('ko-KR', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  if (state.error) {
    s.className = 'status warn';
    s.textContent = (at ? `${state.error} ${when}에 받은 내용을 보여줘요.` : state.error) + offlineStatus();
    return;
  }
  s.textContent = (at ? `GitHub ${cfg().branch} · ${when} 기준` : '') + offlineStatus();
}

function offlineStatus() {
  if (!state.tree) return '';
  const total = state.tree.files.length;
  const stored = state.tree.files.filter((f) => typeof load(`blob:${f.sha}`) === 'string').length;
  const treeStored = load('tree')?.sha === state.tree.sha;
  if (state.caching) return ` · 오프라인 자료 저장 중 ${stored}/${total}`;
  return stored === total && total > 0 && treeStored
    ? ' · 오프라인 자료 모두 저장됨'
    : ` · 오프라인 자료 일부 저장됨 ${stored}/${total}${treeStored ? '' : ' (목록 저장 안 됨)'}`;
}

async function sync({ force = false } = {}) {
  if (!localBase && !cfg().token) return;
  const asked = cfg();
  state.syncing = true; setStatus();
  try {
    const t = await fetchTree();
    // 요청한 뒤 토큰·저장소·브랜치가 바뀌었거나 연결을 지웠으면 옛 응답은 버린다(지운 비공개 목록이 다시 저장되지 않게).
    const now = cfg();
    if (now.token !== asked.token || now.repo !== asked.repo || now.branch !== asked.branch) return;
    const changed = !state.tree || state.tree.sha !== t.sha || force;
    state.tree = { ...t, at: Date.now() };
    state.error = null;
    if (!localBase) {
      save('tree', state.tree);
      const keep = new Set(t.files.map((f) => KEY + 'blob:' + f.sha));
      for (const k of cacheKeys()) if (!keep.has(k)) { try { localStorage.removeItem(k); } catch { /* 없음 */ } }
    }
    if (changed && !/^#\/(add|settings)\b/.test(location.hash)) route(); // 입력 중인 폼은 다시 그리지 않는다
    else if (/^#\/add\b/.test(location.hash)) state.fillBeans?.(); // 추가 화면은 다시 그리지 않고 기존 원두 목록만 채운다
    prefetch();
  } catch (e) {
    state.error = e instanceof HttpError ? e.message : '인터넷에 연결되지 않았어요.';
    if (!state.tree) {
      if (e.status === 401 || e.status === 404) location.hash = '#/settings';
      else route();
    }
  } finally {
    state.syncing = false; setStatus();
  }
}

// 오프라인에서도 열리게 원두 파일을 먼저, 가이드를 다음으로 모두 받아 둔다. 바뀐 파일만 새로 받는다.
async function prefetch() {
  if (localBase || !state.tree) return;
  const run = ++prefetchRun, tree = state.tree;
  const want = tree.files.map((f) => f.path).sort((a, b) => b.startsWith('beans/') - a.startsWith('beans/'));
  state.caching = true; setStatus();
  try {
    for (const p of want) {
      if (run !== prefetchRun || state.tree !== tree) return;
      try { await readFile(p); } catch { /* 다른 자료는 계속 저장한다 */ }
      if (run !== prefetchRun || state.tree !== tree) return;
      setStatus();
    }
  } finally {
    if (run === prefetchRun) { state.caching = false; setStatus(); }
  }
}

// ---------- 마크다운 (HTML은 모두 이스케이프한다) ----------

const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function normPath(dir, href) {
  const out = dir ? dir.split('/') : [];
  for (const part of href.split('/')) {
    if (part === '..') out.pop();
    else if (part && part !== '.') out.push(part);
  }
  return out.join('/');
}

function linkHref(raw, dir) {
  const href = raw.replace(/&amp;/g, '&');
  if (/^https?:\/\//i.test(href)) return { url: href, ext: true };
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
  const [p] = href.split('#');
  if (!p) return null;
  let decoded;
  try { decoded = decodeURIComponent(p); } catch { return null; } // 잘못된 % 표기 하나가 문서 전체를 막지 않게 링크만 글자로 둔다
  const path = normPath(dir, decoded);
  if (/^beans\/[^/]+\.md$/.test(path) && !NON_BEAN.has(path.slice(6))) return { url: `#/bean/${encodeURIComponent(path.slice(6))}` };
  if (/\.md$/.test(path) && state.tree?.files.some((f) => f.path === path)) return { url: `#/doc/${encodeURIComponent(path)}` };
  const { repo, branch } = cfg();
  return { url: `https://github.com/${repo}/blob/${branch}/${path}`, ext: true };
}

const aTag = (l, text) => `<a href="${esc(l.url)}"${l.ext ? ' target="_blank" rel="noopener noreferrer"' : ''}>${text}</a>`;

function inline(src, dir) {
  const slots = [];
  const put = (html) => `\u0000${slots.push(html) - 1}\u0000`;
  let s = src.replace(/`([^`]+)`/g, (_, c) => put(`<code>${esc(c)}</code>`));
  s = esc(s);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, href) => {
    const l = linkHref(href, dir);
    return l ? put(aTag(l, text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>'))) : text;
  });
  s = s.replace(/https?:\/\/(?:(?!&(?:lt|gt|quot|#39);)[^\s<>"'\u0000])+/g, (u) => {
    const tail = /[.,;:!?)\]]+$/.exec(u);
    const url = tail ? u.slice(0, -tail[0].length) : u;
    return put(aTag({ url: url.replace(/&amp;/g, '&'), ext: true }, url)) + (tail ? tail[0] : '');
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, k) => slots[k]);
}

function cellsOf(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

const LIST_RE = /^(\s*)([-*+]|\d+\.)\s+(.*)$/;
const isSep = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

function md(text, dir) {
  const lines = text.split(/\r?\n/);
  let out = '';
  let k = 0;
  const startsBlock = (l, next) => /^```/.test(l) || /^#{1,6}\s/.test(l) || /^\s*>/.test(l) || LIST_RE.test(l)
    || /^\s*(-{3,}|\*{3,})\s*$/.test(l) || (/^\s*\|/.test(l) && next !== undefined && isSep(next));
  while (k < lines.length) {
    const l = lines[k];
    if (!l.trim()) { k++; continue; }
    let m;
    if (/^```/.test(l)) {
      const body = [];
      for (k++; k < lines.length && !/^```/.test(lines[k]); k++) body.push(lines[k]);
      k++;
      out += `<pre><code>${esc(body.join('\n'))}</code></pre>`;
    } else if ((m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l))) {
      const n = m[1].length;
      out += `<h${n}>${inline(m[2], dir)}</h${n}>`;
      k++;
    } else if (/^\s*(-{3,}|\*{3,})\s*$/.test(l)) {
      out += '<hr>'; k++;
    } else if (/^\s*>/.test(l)) {
      const body = [];
      while (k < lines.length && /^\s*>/.test(lines[k])) body.push(lines[k++].replace(/^\s*>\s?/, ''));
      out += `<blockquote>${md(body.join('\n'), dir)}</blockquote>`;
    } else if (/^\s*\|/.test(l) && k + 1 < lines.length && isSep(lines[k + 1])) {
      const head = cellsOf(l);
      k += 2;
      let rows = '';
      while (k < lines.length && /^\s*\|/.test(lines[k])) {
        rows += `<tr>${cellsOf(lines[k++]).map((c) => `<td>${inline(c, dir)}</td>`).join('')}</tr>`;
      }
      out += `<div class="tw"><table><thead><tr>${head.map((c) => `<th>${inline(c, dir)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
    } else if (LIST_RE.test(l)) {
      const items = [];
      while (k < lines.length) {
        const x = LIST_RE.exec(lines[k]);
        if (x) { items.push({ indent: x[1].length, tag: /\d/.test(x[2]) ? 'ol' : 'ul', text: x[3] }); k++; continue; }
        if (lines[k].trim() && /^\s{2,}/.test(lines[k]) && items.length) { items[items.length - 1].text += ' ' + lines[k++].trim(); continue; }
        break;
      }
      const stack = [];
      for (const it of items) {
        const top = stack[stack.length - 1];
        if (!top || it.indent > top.indent) { out += `<${it.tag}>`; stack.push(it); }
        else {
          while (stack.length > 1 && it.indent < stack[stack.length - 1].indent) out += `</li></${stack.pop().tag}>`;
          out += '</li>';
        }
        out += `<li>${inline(it.text, dir)}`;
      }
      while (stack.length) out += `</li></${stack.pop().tag}>`;
    } else {
      const body = [l];
      for (k++; k < lines.length && lines[k].trim() && !startsBlock(lines[k], lines[k + 1]); k++) body.push(lines[k]);
      out += `<p>${inline(body.join(' '), dir)}</p>`;
    }
  }
  return out;
}

// ## 단위로 접는 섹션을 만든다. open(heading) 이 true면 펼친다.
function mdSections(text, dir, open, afterIntro = '') {
  const lines = text.split(/\r?\n/);
  const parts = [{ head: null, body: [] }];
  for (const l of lines) {
    if (/^##\s/.test(l)) parts.push({ head: l.replace(/^##\s+/, ''), body: [] });
    else parts[parts.length - 1].body.push(l);
  }
  return parts.map((p) => {
    const body = md(p.body.join('\n'), dir);
    if (p.head == null) return body + afterIntro;
    return `<details class="sec"${open(p.head) ? ' open' : ''}><summary><h2>${inline(p.head, dir)}</h2></summary>${body}</details>`;
  }).join('');
}

// ---------- 브루 카드 ----------

async function cardUrl(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  const buf = new Uint8Array(await new Response(stream).arrayBuffer());
  let bin = '';
  for (const b of buf) bin += String.fromCharCode(b);
  return `./#1.${btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

async function openCard(obj) {
  if (typeof CompressionStream === 'undefined') { alert('이 브라우저에서는 브루 카드를 만들 수 없어요. Safari나 브라우저를 최신 버전으로 업데이트한 뒤 다시 열어 주세요.'); return; }
  location.href = await cardUrl(obj);
}

const grind = (c, z) => { const a = Array.isArray(c) ? c : [c]; return `C${a.join('~')} / ZP6 ${z || a.map(zp6Of).join('~')}`; };

// ---------- 로스팅 후 경과일 (계산은 brew-core.js roastAge) ----------

const AGE_GUIDE = 'recipes/blends-and-bean-guide.md';

const ageBadge = (a) => `<span class="badge">로스팅 후 ${a.days}일${a.guess ? ' (추정)' : ''}</span>`;

// 파일 버전(sha)마다 한 번만 읽는다. 받아 둔 파일은 이 기기 저장소에서 바로 나온다.
const ages = new Map();
function selectedBag(text, file) {
  const history = bagHistory(text);
  const id = load(`bag:${cfg().repo}:${file}`, history.current);
  return { ...history, bag: history.bags.find((b) => b.id === id) || history.bags.find((b) => b.id === history.current) };
}

function ageOf(file) {
  const k = `${cfg().repo}/${file}@${state.tree?.files.find((f) => f.path === `beans/${file}`)?.sha || ''}@${load(`bag:${cfg().repo}:${file}`, '')}@${new Date().toLocaleDateString('sv-SE')}`;
  if (!ages.has(k)) ages.set(k, readFile(`beans/${file}`).then((text) => { const h = selectedBag(text, file); return h.errors.length ? null : bagAge(h.bag); }, () => null));
  return ages.get(k);
}

// ---------- 화면 ----------

function setTab(tab) {
  for (const a of $('tabs').querySelectorAll('a')) {
    if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
}

function empty(title, msg) {
  return `<div class="empty"><div aria-hidden="true" style="font-size:40px">☕</div><b>${esc(title)}</b><p>${msg}</p></div>`;
}

const errText = (e) => (e instanceof HttpError ? e.message : '인터넷에 연결되지 않았어요. 아직 받아 두지 않은 내용은 연결된 뒤에 열 수 있어요.');

function loading() {
  return state.error ? empty('불러오지 못했어요', `${esc(state.error)} 위의 ↻ 를 눌러 다시 받아 주세요.`) : empty('불러오는 중', 'GitHub에서 받고 있어요.');
}

function needSetup() {
  if (localBase || cfg().token) return false;
  location.replace('#/settings');
  return true;
}

function rowsOf(text) {
  const t = tablesIn(text.split(/\r?\n/))[0];
  if (!t) return [];
  return t.rows.map((r) => Object.fromEntries(t.header.map((h, k) => [h, r[k] ?? ''])));
}

// INDEX.md 의 [이름](파일) 링크에서 파일 이름만 꺼낸다. tablesIn 은 ** 와 ` 만 지운다.
const fileOf = (cell) => (/\(([^)]+\.md)\)/.exec(cell) || /([\w.-]+\.md)/.exec(cell) || [])[1];
const plain = (cell) => cell.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');

async function showBeans() {
  setTab('beans');
  if (needSetup()) return;
  if (!state.tree) { view.innerHTML = loading(); return; }
  let rows = [];
  const seq = screen;
  try { rows = rowsOf(await readFile('beans/INDEX.md')); } catch (e) { if (seq === screen) view.innerHTML = empty('원두 색인을 못 읽었어요', esc(errText(e))); return; }
  if (seq !== screen) return;
  const listed = new Set(rows.map((r) => fileOf(r['파일'] || '')).filter(Boolean));
  for (const f of state.tree.files) {
    const name = f.path.slice(6);
    if (f.path.startsWith('beans/') && !NON_BEAN.has(name) && !listed.has(name)) rows.push({ '원두': name.replace(/\.md$/, ''), '파일': name, '로스터리': '색인에 없음' });
  }
  rows.sort((a, b) => (b['갱신일'] || '').localeCompare(a['갱신일'] || ''));

  view.innerHTML = `<input class="search" id="q" type="search" placeholder="로스터리, 원두, 농장, 품종, 가공으로 찾기" aria-label="원두 찾기" value="${esc(load('q', '') || '')}"><ul class="cards" id="list"></ul>`;
  const list = $('list');
  const done = (r) => /다 마심/.test(r['상태'] || '');
  const item = (r) => {
    const file = fileOf(r['파일'] || '');
    const meta = [r['농장/생산자'], r['품종'], r['가공']].filter((x) => x && x !== '-').map(plain).join(' · ');
    const star = r['최근 평가'] && r['최근 평가'] !== '-' ? `<span>${esc(r['최근 평가'])}</span>` : '';
    return `<li><a class="bean" href="#/bean/${encodeURIComponent(file || '')}">
      <span class="ro">${esc(plain(r['로스터리'] || ''))}${done(r) ? ' <span class="badge">다 마심</span>' : ''}</span>
      <span class="nm">${esc(plain(r['원두'] || ''))}</span>
      ${meta ? `<p class="meta">${esc(meta)}</p>` : ''}
      ${r['로스팅'] ? `<p class="meta">로스팅 ${esc(plain(r['로스팅']))} <span class="age" data-file="${esc(file || '')}"></span></p>` : `<p class="meta age" data-file="${esc(file || '')}"></p>`}
      <span class="foot"><span>${esc(plain(r['드리퍼 · 음료'] || ''))}</span><span>${star} ${esc(r['갱신일'] || '')}</span></span>
    </a></li>`;
  };
  const draw = () => {
    const q = $('q').value.trim().toLowerCase();
    save('q', $('q').value);
    const hits = rows.filter((r) => !q || Object.values(r).join(' ').toLowerCase().includes(q));
    // 찾을 때는 다 마신 원두도 한 목록에, 평소에는 마시는 원두 먼저 보이고 다 마신 원두는 아래에 접어 둔다
    const now = q ? hits : hits.filter((r) => !done(r)), past = q ? [] : hits.filter(done);
    list.innerHTML = hits.length ? now.map(item).join('')
      + (past.length ? `<li><details class="sec"><summary><h2>다 마신 원두 ${past.length}개</h2></summary><ul class="cards">${past.map(item).join('')}</ul></details></li>` : '')
      : `<li>${empty('찾는 원두가 없어요', '다른 말로 찾아 보세요.')}</li>`;
    for (const s of list.querySelectorAll('.age[data-file]')) {
      if (s.dataset.file) ageOf(s.dataset.file).then((a) => { if (a) s.innerHTML = ageBadge(a); });
    }
  };
  $('q').addEventListener('input', draw);
  draw();
}

// 원두 파일 머리의 작성 기록(첫 ## 앞의 > 줄: 작성일·사용자 원문·요청 범위·추가 이력)은 화면에서 뺀다. 파일에는 남는다.
function withoutHeaderNote(text) {
  const lines = text.split(/\r?\n/);
  const end = lines.findIndex((l) => /^##\s/.test(l));
  if (end < 0) return text;
  return [...lines.slice(0, end).filter((l) => !/^>/.test(l)), ...lines.slice(end)].join('\n');
}

// 출처 섹션은 바깥 링크만 한 줄씩: "- 이름 (설명): https://… (열람일)" → "- [이름](https://…)". 링크 없는 기반 문서 줄은 화면에서 뺀다(파일에는 남는다).
function compactSources(text) {
  const out = [], seen = new Set();
  let inSrc = false;
  for (const l of text.split(/\r?\n/)) {
    if (/^##\s/.test(l)) { inSrc = /^##\s+(\d+\.\s*)?(참고\s*)?출처/.test(l); out.push(l); continue; }
    if (!inSrc) { out.push(l); continue; }
    const url = (/^\s*-\s.*?(https?:\/\/[^\s)>\]`]+)/.exec(l) || [])[1];
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const label = l.replace(/^\s*-\s*/, '').split(/:\s|\s*\(|https?:\/\//)[0].replace(/[`*[\]"]/g, '').trim().slice(0, 40);
    out.push(`- [${label || new URL(url).hostname}](${url})`);
  }
  return out.join('\n');
}

async function showBean(name) {
  setTab('beans');
  if (needSetup()) return;
  if (!state.tree) { view.innerHTML = loading(); return; }
  const path = `beans/${name}`;
  let text;
  const seq = screen;
  try { text = await readFile(path); } catch (e) { if (seq === screen) view.innerHTML = `<a class="back" href="#/">← 원두</a>${empty('원두 파일을 못 읽었어요', esc(errText(e)))}`; return; }
  if (seq !== screen) return;
  const bean = parseBeanText(text);
  const byId = new Map(bean.recipes.map((r) => [r.id, r]));
  const evidence = recipeEvidence(text);
  // 드리퍼 묶음(V60 · SOLO 등)과 그 안의 종류(V60 / V60 Switch, SOLO / SOLO SPIN). 묶음은 처음 나온 순서, 묶음 안은 종류 순서 → ICE 먼저.
  const choice = new Map(bean.recipes.map((r) => [r.id, dripperChoice(r, evidence[r.id]?.basis)]));
  const byFamily = new Map(); // 묶음 → { variants: 종류(처음 나온 순서), items: 카드 }
  for (const r of bean.recipes) {
    const { family, variant } = choice.get(r.id);
    if (!byFamily.has(family)) byFamily.set(family, { variants: [], items: [] });
    const g = byFamily.get(family);
    if (!g.variants.includes(variant)) g.variants.push(variant);
    g.items.push(r);
  }
  for (const g of byFamily.values()) {
    g.items.sort((a, b) => g.variants.indexOf(choice.get(a.id).variant) - g.variants.indexOf(choice.get(b.id).variant) || (a.t === b.t ? 0 : a.t === 'ICE' ? -1 : 1));
  }
  const families = [...byFamily.keys()];
  const variantsOf = (family) => byFamily.get(family)?.variants || [];
  const groups = families.map((family) => ({ family, items: byFamily.get(family).items }));
  const history = selectedBag(text, name);
  const age = history.errors.length ? null : bagAge(history.bag);
  const sale = saleStatus(text);
  const ageMsg = age ? `<p class="msg"><b>로스팅 후 ${age.days}일${age.guess ? ' (추정)' : ''}</b> · 로스팅일 ${esc(age.date)} · ${esc(age.range)}: ${esc(age.tip)}. ${aTag({ url: `#/doc/${encodeURIComponent(AGE_GUIDE)}` }, '경과일별 조정표')}</p>` : '';
  const saleMsg = sale ? `<p class="msg"><b>${esc(sale.status)}</b> · ${esc(sale.date)} 확인</p>` : '';
  const bags = history.start < 0 ? '' : `<section class="bag-choice" aria-label="마시는 봉투">
    ${history.errors.length ? `<p class="msg">봉투 이력을 읽지 못했어요. ${esc(history.errors.join(' '))}</p>` : `<label for="bagSelect">지금 마시는 봉투</label><select id="bagSelect">${history.bags.map((b) => `<option value="${esc(b.id)}"${b.id === history.bag.id ? ' selected' : ''}>${esc(b.id)} · 로스팅 ${esc(b.roast)}${b.weight !== '-' ? ` · ${esc(b.weight)}g` : ''}</option>`).join('')}</select><p class="filter-result">이 기기에서 고른 봉투의 로스팅일로 경과일을 계산해요.</p>`}
    <details><summary>봉투 이력 ${history.bags.length}개 보기</summary><div class="tw"><table><thead><tr>${['봉투', '구매일', '로스팅일', '중량(g)', '가격(원)', '구매처', '메모'].map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${history.bags.map((b) => `<tr>${['id', 'purchased', 'roast', 'weight', 'price', 'shop', 'note'].map((k) => `<td>${esc(b[k] || '-')}</td>`).join('')}</tr>`).join('')}</tbody></table></div></details>
    <a href="#/add/${encodeURIComponent(name)}">이 원두 재구매·정보 보완 요청 →</a>
  </section>`;
  const quick = bags + ageMsg + saleMsg + (bean.recipes.length ? `
    <div class="qhead"><h2>브루 카드</h2><span>눌러서 폰용 카드로 열어요</span></div>
    <div class="recipe-filters" role="group" aria-label="브루 카드 필터">
      <label>드리퍼<select id="recipeDripper"><option value="">전체 드리퍼</option>${families.map((f) => `<option value="${esc(f)}">${esc(f)}</option>`).join('')}</select></label>
      <label id="recipeVariantBox" hidden>종류<select id="recipeVariant"></select></label>
      <label>음료<select id="recipeType"><option value="">HOT · ICE 전체</option><option value="HOT">HOT</option><option value="ICE">ICE</option></select></label>
    </div>
    <p class="filter-result" id="recipeCount" aria-live="polite"></p>
    ${groups.map((g) => `<section class="qgroup" data-family="${esc(g.family)}">
    <div class="qgroup-title" role="heading" aria-level="3">${esc(g.family)}</div>
    <div class="qcards">${g.items.map((r) => `
      <div class="recipe-choice">
      <button type="button" class="qcard" data-id="${esc(r.id)}">
        <span class="g">${esc(String(r.g))}g</span>
        <span class="t">${esc(choice.get(r.id).variant)} <span class="badge ${r.t === 'ICE' ? 'ice' : 'hot'}">${esc(r.t)}</span>${r.id === bean.default ? ' <span class="badge ok">기본</span>' : ''}</span>
        <span class="s">${esc(r.id)} · ${esc(grind(r.c, r.z))} · ${esc(String(r.T))}℃${r.ra ? ' · ' + esc(r.ra) : ''}</span>
        <span class="evidence-label">${esc(evidence[r.id]?.label || '근거 구분 미기재')}</span>
      </button>
      <details class="recipe-evidence"><summary>근거 보기</summary>${md([evidence[r.id]?.basis || '레시피에 근거 구분이 적혀 있지 않아요.', evidence[r.id]?.reason || '', ...(evidence[r.id]?.sources || [])].join('\n\n'), 'beans')}</details>
      </div>`).join('')}</div>
    </section>`).join('')}` : '');
  const bodyText = history.start < 0 ? text : text.split(/\r?\n/).filter((_, k) => k < history.start || k >= history.end).join('\n');
  view.innerHTML = `<a class="back" href="#/">← 원두</a><article class="doc">${mdSections(compactSources(withoutHeaderNote(bodyText)), 'beans', (h) => /^(\d+\.\s*)?(레시피|추출 기록)/.test(h), quick)}</article>`;
  if (history.start >= 0 && !history.errors.length) $('bagSelect').addEventListener('change', async (e) => {
    if (seq !== screen) return; // 다른 화면으로 옮겨 가는 중이면 이 원두를 다시 그리지 않는다
    save(`bag:${cfg().repo}:${name}`, e.target.value);
    await showBean(name);
    if (seq === screen) $('bagSelect')?.focus();
  });
  if (bean.recipes.length) {
    const dripper = $('recipeDripper'), variant = $('recipeVariant'), variantBox = $('recipeVariantBox'), type = $('recipeType');
    const pref = load('recipe-filter', {});
    // 종류 칸은 고른 드리퍼 묶음에 종류가 둘 이상일 때만 보인다(V60 → V60 / V60 Switch, SOLO → SOLO / SOLO SPIN).
    const fillVariants = () => {
      const vs = dripper.value ? variantsOf(dripper.value) : [];
      variantBox.hidden = vs.length < 2;
      variant.innerHTML = vs.length < 2 ? '' : `<option value="">${esc(dripper.value)} 전체</option>${vs.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('')}`;
      variant.value = '';
    };
    // 예전 형식(variant 키 없음)의 저장값은 카드의 드리퍼 표기(d)와 같은 카드만 보여 줬다. 같은 카드가 한 종류뿐이면 그 종류로, 여러 종류(SOLO와 SPIN)면 묶음 전체로 옮긴다. 이 원두에 없으면 전체로 되돌린다.
    const oldFormat = !!pref && typeof pref === 'object' && !('variant' in pref);
    const oldHits = oldFormat ? bean.recipes.filter((r) => r.d === pref.dripper) : [];
    const oldVariants = [...new Set(oldHits.map((r) => choice.get(r.id).variant))];
    dripper.value = oldFormat ? (oldHits.length ? choice.get(oldHits[0].id).family : '') : families.includes(pref?.dripper) ? pref.dripper : '';
    fillVariants();
    const wantVariant = oldFormat ? (oldVariants.length === 1 ? oldVariants[0] : '') : pref?.variant;
    if (dripper.value && variantsOf(dripper.value).length > 1 && variantsOf(dripper.value).includes(wantVariant)) variant.value = wantVariant;
    type.value = ['HOT', 'ICE'].includes(pref?.type) ? pref.type : '';
    const filter = () => {
      let count = 0;
      for (const b of view.querySelectorAll('.qcard')) {
        const r = byId.get(b.dataset.id), c = choice.get(r.id);
        b.hidden = !!((dripper.value && c.family !== dripper.value) || (variant.value && c.variant !== variant.value) || (type.value && r.t !== type.value));
        const wrap = b.closest('.recipe-choice');
        if (wrap) wrap.hidden = b.hidden;
        if (!b.hidden) count++;
      }
      for (const g of view.querySelectorAll('.qgroup')) g.hidden = ![...g.querySelectorAll('.qcard')].some((b) => !b.hidden);
      $('recipeCount').textContent = count ? `${bean.recipes.length}개 중 ${count}개를 보여줘요.` : '이 조건의 레시피가 없어요. 필터를 바꿔 주세요.';
    };
    const remember = () => save('recipe-filter', { dripper: dripper.value, variant: variant.value, type: type.value });
    dripper.addEventListener('change', () => { fillVariants(); remember(); filter(); });
    for (const input of [variant, type]) input.addEventListener('change', () => { remember(); filter(); });
    filter();
  }
  for (const b of view.querySelectorAll('.qcard')) b.addEventListener('click', () => openCard(byId.get(b.dataset.id)));
  for (const h of view.querySelectorAll('.doc h3')) {
    const id = (/^(\d+-\d+)\./.exec(h.textContent.trim()) || [])[1];
    if (!id || !byId.has(id)) continue;
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'cardbtn'; btn.textContent = '카드로 보기';
    btn.addEventListener('click', () => openCard(byId.get(id)));
    h.append(btn);
  }
  scrollTo(0, 0);
}

async function showWish() {
  setTab('wish');
  if (needSetup()) return;
  if (!state.tree) { view.innerHTML = loading(); return; }
  let rows = [];
  const seq = screen;
  try { rows = rowsOf(await readFile('beans/WISHLIST.md')); } catch (e) { if (seq === screen) view.innerHTML = empty('구매 후보를 못 읽었어요', esc(errText(e))); return; }
  if (seq !== screen) return;
  if (!rows.length) {
    view.innerHTML = empty('아직 저장한 후보가 없어요', 'Aside나 Claude Code에서 원두를 찾은 뒤 "1번 저장해"라고 하면 여기에 보여요.');
    return;
  }
  rows.reverse();
  view.innerHTML = `<ul class="cards">${rows.map((r) => {
    const link = /https?:\/\/[^\s)]+/.exec(r['링크'] || '');
    const st = r['상태'] || '';
    const bought = fileOf(st);
    const shown = (x) => x && !/^(미확인|미표기)/.test(x);
    const meta = [r['농장/생산자'], r['품종'], r['가공'], r['구분']].filter(shown).map(plain).join(' · ');
    // 로스팅·컵노트 칸은 2026-11-17부터 있다. 예전 행에는 없다.
    const taste = [shown(r['로스팅']) && `로스팅 ${plain(r['로스팅'])}`, shown(r['컵노트']) && `컵노트 ${plain(r['컵노트'])}`].filter(Boolean).join(' · ');
    return `<li><div class="bean">
      <span class="ro">${esc(plain(r['로스터리'] || ''))}</span>
      <span class="nm">${esc(plain(r['상품명'] || ''))}</span>
      ${meta ? `<p class="meta">${esc(meta)}</p>` : ''}
      ${taste ? `<p class="meta">${esc(taste)}</p>` : ''}
      <p class="meta">${esc(plain(r['가격 · 중량'] || ''))}</p>
      <span class="foot"><span>${bought ? `<a href="#/bean/${encodeURIComponent(bought)}">구매함 → 레시피</a>` : `<span class="badge${/제외/.test(st) ? '' : ' ok'}">${esc(st || '후보')}</span>`}</span>
      <span>${link ? aTag({ url: link[0], ext: true }, '상품 페이지') + ' · ' : ''}${esc(r['확인일 · 판매 상태'] || r['저장일'] || '')}</span></span>
    </div></li>`;
  }).join('')}</ul>`;
}

function showDocs() {
  setTab('docs');
  if (needSetup()) return;
  if (!state.tree) { view.innerHTML = loading(); return; }
  const docs = state.tree.files.filter((f) => f.path.startsWith('recipes/') || f.path === 'beans/TEMPLATE.md');
  const order = Object.keys(DOC_NAMES);
  docs.sort((a, b) => ((order.indexOf(a.path) + 1) || 99) - ((order.indexOf(b.path) + 1) || 99) || a.path.localeCompare(b.path));
  view.innerHTML = `<ul class="cards">${docs.map((f) => `<li><a class="bean" href="#/doc/${encodeURIComponent(f.path)}">
    <span class="nm" data-path="${esc(f.path)}">${esc(DOC_NAMES[f.path] || f.path.replace(/^.*\//, '').replace(/\.md$/, ''))}</span>
    <p class="meta">${esc(f.path)}</p></a></li>`).join('')}</ul>`;
  // DOC_NAMES에 없는 문서는 첫 제목(# …)을 이름으로 쓴다. 못 읽으면 파일 이름 그대로 둔다.
  for (const s of view.querySelectorAll('.nm[data-path]')) {
    if (DOC_NAMES[s.dataset.path]) continue;
    readFile(s.dataset.path).then((text) => {
      const h = /^#\s+(.+?)\s*#*\s*$/m.exec(text);
      if (h) s.textContent = clean(h[1]);
    }, () => {});
  }
}

async function showDoc(path) {
  setTab('docs');
  if (needSetup()) return;
  if (!state.tree) { view.innerHTML = loading(); return; }
  view.innerHTML = `<a class="back" href="#/docs">← 가이드</a>${empty('불러오는 중', '')}`;
  let text;
  const seq = screen;
  try { text = await readFile(path); } catch (e) { if (seq === screen) view.innerHTML = `<a class="back" href="#/docs">← 가이드</a>${empty('문서를 못 읽었어요', esc(errText(e)))}`; return; }
  if (seq !== screen) return;
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  view.innerHTML = `<a class="back" href="#/docs">← 가이드</a><article class="doc">${mdSections(text, dir, () => false)}</article>`;
  scrollTo(0, 0);
}

function showSettings() {
  setTab('');
  const c = cfg();
  view.innerHTML = `
    <h2 style="font-size:19px;margin:4px 0 6px">GitHub 연결</h2>
    <p>원두 기록은 비공개 저장소에 있어서, 이 기기에서 한 번만 <b>읽기 전용 토큰</b>을 넣어 주세요. 토큰은 이 기기 브라우저에만 저장돼요.</p>
    <ol class="steps">
      <li><a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer">GitHub 토큰 만들기 페이지</a>를 열어요. (Fine-grained token)</li>
      <li><b>Repository access</b>: Only select repositories → <code>${esc(c.repo.split('/')[1] || c.repo)}</code></li>
      <li><b>Permissions → Repository permissions → Contents</b>: Read-only. 원두·가이드를 읽을 때는 이 권한만 있으면 돼요. (추가 탭에서 원두 요청을 버튼 한 번으로 보내고 봉투 사진을 올리려면 <b>Issues</b>: Read and write도 줘요. 링크만이면 안 줘도 GitHub 화면을 거쳐 보낼 수 있어요.)</li>
      <li>추가 탭에서 요청 처리 상태도 보려면 <b>Issues: Read-only</b> 이상, PR 머지 여부까지 확인하려면 <b>Pull requests: Read-only</b>를 더 주세요.</li>
      <li>만든 토큰(<code>github_pat_…</code>)을 아래에 붙여 넣어요.</li>
    </ol>
    <form class="form" id="f">
      <label for="tok">토큰</label>
      <input id="tok" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${c.token ? '저장됨 (바꾸려면 새로 붙여 넣기)' : 'github_pat_…'}">
      <label for="repo">저장소</label>
      <input id="repo" autocapitalize="off" spellcheck="false" value="${esc(c.repo)}">
      <p class="help">기본값 그대로 두면 돼요.</p>
      <div class="row">
        <button class="btn" type="submit">저장하고 연결</button>
        ${c.token ? '<button class="btn ghost" type="button" id="forget">이 기기에서 토큰 지우기</button>' : ''}
      </div>
    </form>
    <div id="fmsg"></div>
    <p style="margin-top:24px"><a href="./">브루 카드 (최근 카드) 열기</a></p>`;
  $('f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const token = $('tok').value.trim() || c.token;
    const repo = $('repo').value.trim() || DEFAULT_REPO;
    if (!token) { $('fmsg').innerHTML = '<p class="msg">토큰을 붙여 넣어 주세요.</p>'; return; }
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) { $('fmsg').innerHTML = '<p class="msg">저장소는 <code>소유자/이름</code> 형식이에요.</p>'; return; }
    const prev = load('cfg', {});
    if (!save('cfg', { ...prev, token, repo })) {
      $('fmsg').innerHTML = '<p class="msg">이 기기에 설정을 저장하지 못했어요. 저장 공간이나 사생활 보호 모드를 확인해 주세요.</p>';
      return;
    }
    $('fmsg').innerHTML = '<p class="msg">연결하는 중…</p>';
    try {
      if (prev.repo && prev.repo !== repo) { drop('tree'); state.tree = null; }
      await fetchTree();
      $('fmsg').innerHTML = '<p class="msg ok">연결됐어요.</p>';
      await sync({ force: true });
      location.hash = '#/';
    } catch (err) {
      save('cfg', prev);
      $('fmsg').innerHTML = `<p class="msg">${esc(err instanceof HttpError ? err.message : '인터넷에 연결되지 않았어요.')}</p>`;
    }
  });
  $('forget')?.addEventListener('click', () => {
    prefetchRun++; state.caching = false;
    drop('cfg'); drop('tree'); drop('q');
    for (const k of cacheKeys()) { try { localStorage.removeItem(k); } catch { /* 없음 */ } }
    state.tree = null; state.error = null; setStatus();
    showSettings();
    $('fmsg').innerHTML = '<p class="msg ok">토큰과 받아 둔 내용을 지웠어요.</p>';
  });
}

// ---------- 원두 추가 (요청 이슈) ----------

// 상품 링크·봉투 사진을 '원두 요청' 이슈로 남긴다. Claude Code에서 "원두 요청 처리해줘"라고 하면 스킬 §9가 원두 파일을 만들어 PR로 올린다.
// 토큰에 Issues 쓰기 권한이 있으면 바로 만들고, 없으면(읽기 전용) 링크만 내용을 채운 GitHub 이슈 양식으로 보낸다.
// 사진은 긴 변 PHOTO_MAX로 줄인 JPEG(캔버스로 다시 그려 위치 정보는 남지 않는다)를 base64로 이슈 댓글 여러 개에 나눠 붙이고,
// 스킬이 읽은 뒤 그 댓글을 지운다(scripts/bean-requests.mjs photos·purge, 형식은 같은 파일의 photosOf).
const REQUEST_LABEL = '원두 요청';
const PHOTO_MAX = 1400, PHOTO_CHUNK = 60000, PHOTO_LIMIT = 4;
const SS_LINK = /^https?:\/\/(?:m\.)?smartstore\.naver\.com\/([^/?#\s]+)\/products\/(\d+)/;
const cleanLink = (u) => {
  const m = SS_LINK.exec(u);
  return m ? `https://smartstore.naver.com/${m[1]}/products/${m[2]}` : u.replace(/[?&](NaPm|utm_[a-z]+)=[^&#]*/g, '').replace(/[)\],.;]+$/, '');
};
const linkKey = (u) => { const m = SS_LINK.exec(u); return m ? `ss:${m[1]}/${m[2]}` : cleanLink(u); };
const linksIn = (text) => [...new Set((text.match(/https?:\/\/[^\s<>"']+/g) || []).map(cleanLink))];

function requestStatusOf(issue, pr) {
  if (pr?.merged_at && pr.base?.ref === cfg().branch) return '반영 완료';
  if (issue.state === 'closed') return '닫힘';
  if (pr?.state === 'open') return 'PR 열림';
  if (pr?.state === 'closed') return 'PR 닫힘 · 미반영';
  return issue.labels?.some((l) => (l.name || l) === '처리 중') ? '처리 중' : '접수';
}

// bean-pr.sh가 남긴 "PR: ..." 댓글의 같은 저장소 PR만 확인한다.
async function requestPR(issue, repo) {
  if (!issue.comments) return null;
  let number = null;
  for (let page = 1; ; page++) {
    const comments = await gh(`/repos/${repo}/issues/${issue.number}/comments?per_page=100&page=${page}`);
    for (const c of comments) {
      for (const m of (c.body || '').matchAll(/PR:\s*(https:\/\/github\.com\/[^\s<>]+)/g)) {
        try {
          const u = new URL(m[1]);
          const prefix = `/${repo}/pull/`;
          if (u.pathname.startsWith(prefix) && /^\d+$/.test(u.pathname.slice(prefix.length))) number = u.pathname.slice(prefix.length);
        } catch { /* PR 링크가 아니면 건너뛴다 */ }
      }
    }
    if (comments.length < 100) break;
  }
  return number ? gh(`/repos/${repo}/pulls/${number}`) : null;
}

const requestRuns = new WeakMap();
async function showRequests(panel, repo) {
  if (!panel.isConnected) return;
  const run = (requestRuns.get(panel) || 0) + 1;
  requestRuns.set(panel, run);
  if (localBase || !cfg().token) {
    panel.textContent = 'GitHub을 연결하면 최근 원두 요청의 처리 상태를 볼 수 있어요.';
    return;
  }
  panel.textContent = '최근 요청을 확인하는 중…';
  const current = () => panel.isConnected && cfg().repo === repo && requestRuns.get(panel) === run;
  try {
    const issues = await gh(`/repos/${repo}/issues?labels=${encodeURIComponent(REQUEST_LABEL)}&state=all&sort=created&direction=desc&per_page=10`);
    if (!current()) return;
    const rows = [];
    for (const issue of issues.filter((i) => !i.pull_request)) {
      let pr = null, unknown = false;
      try { pr = await requestPR(issue, repo); } catch { unknown = true; }
      if (!current()) return;
      const status = requestStatusOf(issue, pr);
      rows.push(`<li><span class="badge${status === '반영 완료' ? ' ok' : ''}">${esc(status)}</span> ${aTag({ url: issue.html_url, ext: true }, `#${issue.number} ${esc(issue.title)}`)}${pr ? ` · ${aTag({ url: pr.html_url, ext: true }, 'PR 보기')}` : ''}${unknown ? '<span class="request-note">PR 상태를 확인하지 못했어요. 연결과 토큰의 Pull requests 읽기 권한을 확인해 주세요.</span>' : ''}</li>`);
    }
    panel.innerHTML = rows.length ? `<ul class="request-list">${rows.join('')}</ul>` : '<p>아직 보낸 요청이 없어요.</p>';
  } catch (e) {
    if (current()) panel.textContent = e instanceof HttpError && [401, 403, 404].includes(e.status)
      ? '요청을 읽을 수 없어요. 토큰에 Issues 읽기 권한이 있는지 확인해 주세요.'
      : '요청 상태를 불러오지 못했어요. 인터넷 연결을 확인하고 다시 확인해 주세요.';
  }
}

function requestOf({ links, photos, roast, bean, memo, bagAction = '', purchased = '', weight = '', price = '', shop = '', bagId = '' }) {
  const host = (u) => { try { return new URL(u).pathname.split('/')[1] || new URL(u).hostname; } catch { return u; } };
  const what = links.length ? `${host(links[0])}${links.length > 1 ? ` 외 ${links.length - 1}개` : ''}` : `사진 ${photos}장`;
  const title = bean ? `원두 요청: ${bean.replace(/\.md$/, '')} ${bagAction === 'add' ? '재구매' : '보완'}` : `원두 요청: ${what}`;
  const sec = (h, v) => `### ${h}\n\n${v || '_No response_'}`;
  return {
    title,
    body: [sec('상품 링크', links.join('\n')), sec('사진', photos ? `${photos}장 (댓글로 붙임. Claude Code가 읽은 뒤 지워요)` : ''),
      sec('로스팅일', roast), sec('기존 원두', bean), sec('메모', memo),
      ...(bean || purchased || weight || price || shop ? [sec('봉투 작업', bagAction === 'add' ? '재구매' : '정보 보완'), sec('봉투 ID', bagAction === 'add' ? '' : bagId), sec('구매일', purchased), sec('중량(g)', weight), sec('가격(원)', price), sec('구매처', shop)] : [])].join('\n\n'),
  };
}

async function photoData(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const k = Math.min(1, PHOTO_MAX / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k);
    c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const d = c.toDataURL('image/jpeg', 0.8);
    c.width = c.height = 0;
    return d.slice(d.indexOf(',') + 1);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// 댓글 하나에 65,536자까지라 PHOTO_CHUNK자씩 나눈다.
const photoComments = (name, data) => {
  const n = Math.ceil(data.length / PHOTO_CHUNK);
  return Array.from({ length: n }, (_, k) => `<!-- bean-photo name=${name} part=${k + 1}/${n} -->\n<details><summary>사진 ${name} (${k + 1}/${n}) · 읽은 뒤 지워져요</summary>\n\n\`\`\`\n${data.slice(k * PHOTO_CHUNK, (k + 1) * PHOTO_CHUNK)}\n\`\`\`\n</details>`);
};

// 중복 확인: 이미 저장된 원두의 상품 링크(받아 둔 원두 파일만 본다)와 아직 열린 요청의 링크(토큰에 Issues 읽기 권한이 있을 때만).
async function dupsOf(links, bean) {
  const want = new Map(links.map((u) => [linkKey(u), u]));
  const out = [];
  for (const f of state.tree?.files || []) {
    const name = f.path.slice(6);
    if (!f.path.startsWith('beans/') || NON_BEAN.has(name) || name === bean) continue;
    let text;
    try { text = await readFile(f.path); } catch { continue; }
    const row = text.split(/\r?\n/).map(splitRow).find((c) => c && c[0] === '상품 링크');
    for (const u of row ? linksIn(row[1]) : []) if (want.has(linkKey(u))) out.push(`이미 저장된 원두예요: <a href="#/bean/${encodeURIComponent(name)}">${esc(name.replace(/\.md$/, ''))}</a>`);
  }
  if (!localBase && cfg().token) {
    try {
      const open = await gh(`/repos/${cfg().repo}/issues?labels=${encodeURIComponent(REQUEST_LABEL)}&state=open&per_page=100`);
      for (const i of open) if (linksIn(i.body || '').some((u) => want.has(linkKey(u)))) out.push(`이미 보낸 요청에 있어요: ${aTag({ url: i.html_url, ext: true }, `#${i.number}`)}`);
    } catch { /* Issues 읽기 권한이 없으면 건너뛴다 */ }
  }
  return out;
}

function showAdd(target = '') {
  setTab('add');
  const { repo } = cfg();
  view.innerHTML = `
    <h2 style="font-size:19px;margin:4px 0 6px">원두 추가</h2>
    <p>산 원두의 상품 링크나 봉투·원두카드 사진을 보내면 저장소에 <b>원두 요청</b>이 생겨요. Claude Code에서 "원두 요청 처리해줘"라고 하면 사진에서 원두 이름·로스팅일을 읽고 레시피를 만들어 PR로 올려요. PR을 머지하면 원두 목록에 나와요. 사진은 읽은 뒤 지워요.</p>
    <form class="form" id="af">
      <label for="bean">어느 원두</label>
      <select id="bean"><option value="">새 원두</option></select>
      <p class="help">이미 저장한 원두에 상품 링크나 사진을 더 보낼 때 고르세요.</p>
      <label for="bagAction">기존 원두 작업</label>
      <select id="bagAction"><option value="update">정보 보완</option><option value="add">재구매 · 새 봉투 추가</option></select>
      <p class="help">재구매는 위에서 기존 원두를 골라 주세요. 이전 봉투와 레시피는 보존해요.</p>
      <label for="urls">상품 링크 (없으면 비워 두기)</label>
      <textarea id="urls" rows="3" autocapitalize="off" spellcheck="false" placeholder="https://smartstore.naver.com/…&#10;한 줄에 하나씩"></textarea>
      <label for="photos">봉투·원두카드 사진 (${PHOTO_LIMIT}장까지)</label>
      <input id="photos" type="file" accept="image/*" multiple>
      <div class="thumbs" id="thumbs"></div>
      <label for="roast">로스팅일 (알면)</label>
      <input id="roast" type="date">
      <details class="bag-choice"><summary>구매 정보 (선택)</summary>
        <label for="purchased">구매일</label><input id="purchased" type="date">
        <label for="weight">중량(g)</label><input id="weight" type="number" min="0.1" step="any" inputmode="decimal">
        <label for="price">가격(원)</label><input id="price" type="number" min="0" step="1" inputmode="numeric">
        <label for="shop">구매처</label><input id="shop" placeholder="예: 로스터리 온라인몰">
      </details>
      <label for="memo">메모</label>
      <input id="memo" placeholder="예: 아이스만, 500g 샀어요">
      <div class="row"><button class="btn" type="submit" id="send">요청 보내기</button></div>
    </form>
    <div id="amsg" aria-live="polite"></div>
    <section class="requests" aria-labelledby="requestHeading">
      <div class="qhead"><h2 id="requestHeading">최근 원두 요청 10개</h2><button type="button" class="cardbtn" id="refreshRequests">다시 확인</button></div>
      <div id="requests" aria-live="polite"></div>
    </section>`;
  const panel = $('requests'), form = $('af'), message = $('amsg'), send = $('send'), thumbs = $('thumbs'), selectBean = $('bean');
  const refresh = $('refreshRequests');
  let refreshing = 0;
  const refreshRequests = async () => {
    const run = ++refreshing;
    refresh.disabled = true;
    try { await showRequests(panel, repo); } finally { if (run === refreshing) refresh.disabled = false; }
  };
  refresh.addEventListener('click', refreshRequests);
  refreshRequests();
  const msg = (html, ok) => { message.innerHTML = `<p class="msg${ok ? ' ok' : ''}">${html}</p>`; };
  // 기존 원두 목록. 목록 캐시 없이 열었다면 sync()가 목록을 받은 뒤 다시 불러 채운다(여러 번 불려도 옵션이 겹치지 않는다).
  let filled = false;
  const fillBeans = async () => {
    if (!state.tree || !selectBean.isConnected) return;
    try {
      const rows = rowsOf(await readFile('beans/INDEX.md'));
      const chosen = filled ? selectBean.value : target; // 주소로 받은 대상은 처음 채울 때만 고른다. 그 뒤에 사용자가 고른 "새 원두"(빈 값)는 그대로 둔다.
      filled = true;
      for (const o of selectBean.querySelectorAll('option[data-row]')) o.remove();
      selectBean.insertAdjacentHTML('beforeend', rows.map((r) => {
        const f = fileOf(r['파일'] || '');
        return f ? `<option data-row="1" value="${esc(f)}">${esc(plain(`${r['로스터리'] || ''} · ${r['원두'] || ''}`))}</option>` : '';
      }).join(''));
      selectBean.value = chosen;
    } catch { /* 목록 없이 새 원두만 */ }
  };
  state.fillBeans = fillBeans;
  fillBeans();
  const clearPreviews = () => {
    for (const img of thumbs.querySelectorAll('img')) URL.revokeObjectURL(img.src);
    thumbs.innerHTML = '';
  };
  $('photos').addEventListener('change', () => {
    clearPreviews();
    $('thumbs').innerHTML = [...$('photos').files].slice(0, PHOTO_LIMIT).map((f) => `<img alt="" src="${URL.createObjectURL(f)}">`).join('');
    for (const img of $('thumbs').querySelectorAll('img')) img.addEventListener('load', () => URL.revokeObjectURL(img.src), { once: true });
  });

  let confirmed = false, busy = false;
  $('af').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    const links = linksIn($('urls').value);
    const files = [...$('photos').files];
    const req = { links, photos: files.length, roast: $('roast').value, bean: $('bean').value, memo: $('memo').value.trim(), bagAction: $('bagAction').value, purchased: $('purchased').value, weight: $('weight').value, price: $('price').value, shop: $('shop').value.trim() };
    req.bagId = req.bean ? load(`bag:${repo}:${req.bean}`, '') : '';
    if (req.bagAction === 'add' && !req.bean) return msg('재구매할 기존 원두를 골라 주세요.');
    if (!links.length && !files.length && !(req.bean && (req.roast || req.memo || req.bagAction === 'add' || req.purchased || req.weight || req.price || req.shop))) return msg('상품 링크나 사진을 넣어 주세요.');
    if (files.length > PHOTO_LIMIT) return msg(`사진은 ${PHOTO_LIMIT}장까지 보낼 수 있어요.`);
    if (files.length && (localBase || !cfg().token)) return msg('사진은 이 화면에서 바로 보내야 해요. ⚙ 설정에서 토큰을 넣어 주세요.');
    busy = true;
    send.disabled = true;
    try {
      if (!confirmed && links.length) {
        msg('같은 원두가 이미 있는지 보는 중…');
        const dups = await dupsOf(links, req.bean);
        if (dups.length) {
          confirmed = true;
          return msg(`${dups.join('<br>')}<br>그래도 보내려면 <b>요청 보내기</b>를 한 번 더 눌러 주세요. 있는 원두에 붙이려면 위에서 그 원두를 고르세요.`);
        }
      }
      const { title, body } = requestOf(req);
      let issue;
      try {
        msg('보내는 중…');
        issue = await gh(`/repos/${repo}/issues`, { title, body, labels: [REQUEST_LABEL] });
      } catch (err) {
        if (!(err instanceof HttpError && [401, 403, 404, 422].includes(err.status))) return msg(esc(errText(err)));
        if (files.length) return msg('토큰이 읽기 전용이라 사진을 보낼 수 없어요. ⚙ 설정의 안내대로 토큰에 <b>Issues: Read and write</b> 권한을 더 주세요.');
        const form = `https://github.com/${repo}/issues/new?` + new URLSearchParams({ template: 'bean-request.yml', title, urls: links.join('\n'), roast: req.roast, bean: req.bean, memo: req.memo, kind: req.bagAction === 'add' ? '재구매' : '정보 보완', bagid: req.bagId, purchased: req.purchased, weight: req.weight, price: req.price, shop: req.shop });
        return msg(`토큰이 읽기 전용이라 여기서 바로 보낼 수 없어요. GitHub 화면에서 <b>Create</b>를 눌러 주세요.<br><a class="btn" href="${esc(form)}" target="_blank" rel="noopener noreferrer">GitHub에서 요청 보내기</a>`);
      }
      const commentIds = [];
      for (let k = 0; k < files.length; k++) {
        msg(`사진 ${k + 1}/${files.length} 올리는 중…`);
        try {
          const parts = photoComments(`photo-${k + 1}.jpg`, await photoData(files[k]));
          for (const c of parts) {
            const comment = await gh(`/repos/${repo}/issues/${issue.number}/comments`, { body: c });
            commentIds.push(comment.id);
          }
        } catch (err) {
          let cleanupFailed = false;
          for (const id of commentIds) {
            try { await gh(`/repos/${repo}/issues/comments/${id}`, undefined, 'DELETE'); } catch { cleanupFailed = true; }
          }
          try { await gh(`/repos/${repo}/issues/${issue.number}`, { state: 'closed', state_reason: 'not_planned' }, 'PATCH'); } catch { cleanupFailed = true; }
          return msg(cleanupFailed
            ? `#${issue.number}에 사진 일부가 남았어요. Claude Code에서 '원두 요청 사진 정리해줘'라고 하면 지워요.`
            : `사진을 올리지 못해 요청 #${issue.number}을 닫았어요. 다시 보내 주세요.`);
        }
      }
      form.reset();
      clearPreviews();
      confirmed = false;
      msg(`요청을 보냈어요. ${aTag({ url: issue.html_url, ext: true }, `#${issue.number} 보기`)}<br>Claude Code에서 "원두 요청 처리해줘"라고 하면 돼요.`, true);
      if (panel.isConnected) refreshRequests();
    } finally {
      busy = false;
      send.disabled = false;
    }
  });
  for (const id of ['urls', 'bean']) $(id).addEventListener('input', () => { confirmed = false; });
}

function route() {
  screen++;
  const h = location.hash.replace(/^#\/?/, '');
  const [kind, ...rest] = h.split('/');
  let arg;
  try { arg = decodeURIComponent(rest.join('/')); } catch { arg = ''; } // 잘못된 주소는 목록으로 돌아간다
  if (kind === 'bean' && arg) return showBean(arg);
  if (kind === 'wish') return showWish();
  if (kind === 'docs') return showDocs();
  if (kind === 'doc' && arg) return showDoc(arg);
  if (kind === 'settings') return showSettings();
  if (kind === 'add') return showAdd(arg);
  return showBeans();
}

window.addEventListener('hashchange', route);
$('bSync').addEventListener('click', () => sync({ force: true }));
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(); });
setStatus();
route();
sync();
if (!localBase) registerSW();
