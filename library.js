// 원두 노트: 비공개 저장소(my-coffe-recipe)의 beans/·recipes/를 GitHub API로 읽어 보여준다.
// 이 파일과 페이지는 공개 저장소에 올라가지만 내용은 없다. 내용은 이 기기에 저장한 읽기 전용 토큰으로만 읽는다.
// 개발용: library.html?local=../ 이면 GitHub 대신 같은 서버의 ../beans/, ../recipes/를 읽는다.

import { tablesIn, parseBeanText } from './brew-core.js';

const KEY = 'coffee-lib:';
const DEFAULT_REPO = 'ipadorusa/my-coffe-recipe';
const NON_BEAN = new Set(['TEMPLATE.md', 'INDEX.md', 'WISHLIST.md']);
const DOC_NAMES = {
  'recipes/v60-switch.md': 'V60 Switch 레시피',
  'recipes/orea.md': 'OREA O1 레시피',
  'recipes/graycano.md': '그레이카노 레시피',
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

async function gh(path) {
  const { token } = cfg();
  const res = await fetch(`${apiBase}${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    cache: 'no-store',
  });
  if (!res.ok) {
    const msg = res.status === 401 ? '토큰이 맞지 않거나 만료됐어요.'
      : res.status === 404 ? '저장소를 찾을 수 없어요. 토큰에 이 저장소 읽기 권한이 있는지 확인해 주세요.'
      : res.status === 403 ? 'GitHub이 요청을 막았어요(권한 또는 요청 한도). 잠시 뒤 다시 해 주세요.'
      : `GitHub 응답 ${res.status}`;
    throw new HttpError(res.status, msg);
  }
  return res.json();
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
      const { repo } = cfg();
      const b = await gh(`/repos/${repo}/git/blobs/${f.sha}`);
      const text = b.encoding === 'base64' ? b64ToText(b.content) : b.content;
      save(`blob:${f.sha}`, text);
      return text;
    })().finally(() => pending.delete(f.sha)));
  }
  return pending.get(f.sha);
}

// ---------- 상태와 동기화 ----------

const state = { tree: load('tree'), syncing: false, offline: false, error: null };

function setStatus() {
  const s = $('status');
  s.className = 'status';
  if (localBase) { s.textContent = `개발 모드: ${localBase} 에서 읽는 중`; return; }
  if (state.syncing) { s.textContent = 'GitHub에서 받는 중…'; return; }
  const at = state.tree?.at ? new Date(state.tree.at) : null;
  const when = at ? at.toLocaleString('ko-KR', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  if (state.error) {
    s.className = 'status warn';
    s.textContent = at ? `${state.error} ${when}에 받은 내용을 보여줘요.` : state.error;
    return;
  }
  s.textContent = at ? `GitHub ${cfg().branch} · ${when} 기준` : '';
}

async function sync({ force = false } = {}) {
  if (!localBase && !cfg().token) return;
  state.syncing = true; setStatus();
  try {
    const t = await fetchTree();
    const changed = !state.tree || state.tree.sha !== t.sha || force;
    state.tree = { ...t, at: Date.now() };
    state.error = null;
    if (!localBase) {
      save('tree', state.tree);
      const keep = new Set(t.files.map((f) => KEY + 'blob:' + f.sha));
      for (const k of cacheKeys()) if (!keep.has(k)) { try { localStorage.removeItem(k); } catch { /* 없음 */ } }
    }
    if (changed) route();
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
  const want = state.tree.files.map((f) => f.path).sort((a, b) => b.startsWith('beans/') - a.startsWith('beans/'));
  for (const p of want) { try { await readFile(p); } catch { break; } }
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
  const path = normPath(dir, decodeURIComponent(p));
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
  if (typeof CompressionStream === 'undefined') { alert('이 브라우저는 브루 카드를 만들 수 없어요. iOS 16.4 이상이나 최신 브라우저에서 열어 주세요.'); return; }
  location.href = await cardUrl(obj);
}

const grind = (c) => `C${Array.isArray(c) ? c.join('~') : c}`;

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
  try { rows = rowsOf(await readFile('beans/INDEX.md')); } catch (e) { view.innerHTML = empty('원두 색인을 못 읽었어요', esc(errText(e))); return; }
  const listed = new Set(rows.map((r) => fileOf(r['파일'] || '')).filter(Boolean));
  for (const f of state.tree.files) {
    const name = f.path.slice(6);
    if (f.path.startsWith('beans/') && !NON_BEAN.has(name) && !listed.has(name)) rows.push({ '원두': name.replace(/\.md$/, ''), '파일': name, '로스터리': '색인에 없음' });
  }
  rows.sort((a, b) => (b['갱신일'] || '').localeCompare(a['갱신일'] || ''));

  view.innerHTML = `<input class="search" id="q" type="search" placeholder="로스터리, 원두, 농장, 품종, 가공으로 찾기" aria-label="원두 찾기" value="${esc(load('q', '') || '')}"><ul class="cards" id="list"></ul>`;
  const list = $('list');
  const draw = () => {
    const q = $('q').value.trim().toLowerCase();
    save('q', $('q').value);
    const hits = rows.filter((r) => !q || Object.values(r).join(' ').toLowerCase().includes(q));
    list.innerHTML = hits.length ? hits.map((r) => {
      const file = fileOf(r['파일'] || '');
      const meta = [r['농장/생산자'], r['품종'], r['가공']].filter((x) => x && x !== '-').map(plain).join(' · ');
      const star = r['최근 평가'] && r['최근 평가'] !== '-' ? `<span>${esc(r['최근 평가'])}</span>` : '';
      return `<li><a class="bean" href="#/bean/${encodeURIComponent(file || '')}">
        <span class="ro">${esc(plain(r['로스터리'] || ''))}</span>
        <span class="nm">${esc(plain(r['원두'] || ''))}</span>
        ${meta ? `<p class="meta">${esc(meta)}</p>` : ''}
        ${r['로스팅'] ? `<p class="meta">로스팅 ${esc(plain(r['로스팅']))}</p>` : ''}
        <span class="foot"><span>${esc(plain(r['드리퍼 · 음료'] || ''))}</span><span>${star} ${esc(r['갱신일'] || '')}</span></span>
      </a></li>`;
    }).join('') : `<li>${empty('찾는 원두가 없어요', '다른 말로 찾아 보세요.')}</li>`;
  };
  $('q').addEventListener('input', draw);
  draw();
}

async function showBean(name) {
  setTab('beans');
  if (needSetup()) return;
  if (!state.tree) { view.innerHTML = loading(); return; }
  const path = `beans/${name}`;
  let text;
  try { text = await readFile(path); } catch (e) { view.innerHTML = `<a class="back" href="#/">← 원두</a>${empty('원두 파일을 못 읽었어요', esc(errText(e)))}`; return; }
  const bean = parseBeanText(text);
  const byId = new Map(bean.recipes.map((r) => [r.id, r]));
  const quick = bean.recipes.length ? `
    <div class="qhead"><h2>브루 카드</h2><span>눌러서 폰용 카드로 열어요</span></div>
    <div class="qcards">${bean.recipes.map((r) => `
      <button type="button" class="qcard" data-id="${esc(r.id)}">
        <span class="g">${esc(String(r.g))}g</span>
        <span class="t">${esc(r.d)} <span class="badge ${r.t === 'ICE' ? 'ice' : 'hot'}">${esc(r.t)}</span>${r.id === bean.default ? ' <span class="badge ok">기본</span>' : ''}</span>
        <span class="s">${esc(r.id)} · ${esc(grind(r.c))} · ${esc(String(r.T))}℃${r.ra ? ' · ' + esc(r.ra) : ''}</span>
      </button>`).join('')}</div>` : '';
  view.innerHTML = `<a class="back" href="#/">← 원두</a><article class="doc">${mdSections(text, 'beans', (h) => /^(\d+\.\s*)?(레시피|추출 기록)/.test(h), quick)}</article>`;
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
  try { rows = rowsOf(await readFile('beans/WISHLIST.md')); } catch (e) { view.innerHTML = empty('구매 후보를 못 읽었어요', esc(errText(e))); return; }
  if (!rows.length) {
    view.innerHTML = empty('아직 저장한 후보가 없어요', 'Aside에서 원두를 찾은 뒤 "1번 저장해"라고 하면 여기에 보여요.');
    return;
  }
  rows.reverse();
  view.innerHTML = `<ul class="cards">${rows.map((r) => {
    const link = /https?:\/\/[^\s)]+/.exec(r['링크'] || '');
    const st = r['상태'] || '';
    const bought = fileOf(st);
    const meta = [r['농장/생산자'], r['품종'], r['가공'], r['구분']].filter((x) => x && x !== '미확인').map(plain).join(' · ');
    return `<li><div class="bean">
      <span class="ro">${esc(plain(r['로스터리'] || ''))}</span>
      <span class="nm">${esc(plain(r['상품명'] || ''))}</span>
      ${meta ? `<p class="meta">${esc(meta)}</p>` : ''}
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
    <span class="nm">${esc(DOC_NAMES[f.path] || f.path.replace(/^.*\//, '').replace(/\.md$/, ''))}</span>
    <p class="meta">${esc(f.path)}</p></a></li>`).join('')}</ul>`;
}

async function showDoc(path) {
  setTab('docs');
  if (needSetup()) return;
  if (!state.tree) { view.innerHTML = loading(); return; }
  view.innerHTML = `<a class="back" href="#/docs">← 가이드</a>${empty('불러오는 중', '')}`;
  let text;
  try { text = await readFile(path); } catch (e) { view.innerHTML = `<a class="back" href="#/docs">← 가이드</a>${empty('문서를 못 읽었어요', esc(errText(e)))}`; return; }
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
      <li><b>Permissions → Repository permissions → Contents</b>: Read-only. 다른 권한은 주지 않아요.</li>
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
    save('cfg', { ...prev, token, repo });
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
    drop('cfg'); drop('tree'); drop('q');
    for (const k of cacheKeys()) { try { localStorage.removeItem(k); } catch { /* 없음 */ } }
    state.tree = null; state.error = null; setStatus();
    showSettings();
    $('fmsg').innerHTML = '<p class="msg ok">토큰과 받아 둔 내용을 지웠어요.</p>';
  });
}

function route() {
  const h = location.hash.replace(/^#\/?/, '');
  const [kind, ...rest] = h.split('/');
  const arg = decodeURIComponent(rest.join('/'));
  if (kind === 'bean' && arg) return showBean(arg);
  if (kind === 'wish') return showWish();
  if (kind === 'docs') return showDocs();
  if (kind === 'doc' && arg) return showDoc(arg);
  if (kind === 'settings') return showSettings();
  return showBeans();
}

window.addEventListener('hashchange', route);
$('bSync').addEventListener('click', () => sync({ force: true }));
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(); });
setStatus();
route();
sync();
if ('serviceWorker' in navigator && !localBase) navigator.serviceWorker.register('sw.js').catch(() => {});
