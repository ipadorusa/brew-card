// brew-core.js: 원두 파일(beans/*.md) 텍스트에서 표준 레시피 블록을 읽고, 브루 카드의 원두량 계산을 한다.
// Node(scripts/*.mjs, tests/)와 브라우저(library.js, card.js)가 같이 쓴다. DOM을 쓰지 않는다. 의존성 없음.
// 형식 명세: viewer/FORMAT.md

export const LIMIT = { b: 25, a: 60, act: 20 };
const KEY_ORDER = ['b', 'r', 'd', 't', 'g', 'c', 'z', 'T', 'w', 'i', 'p', 'ra', 'f', 's', 'tt', 'a', 'id'];

// ---------- 문자열 다듬기 ----------

export const clean = (s) => s.replace(/\*\*/g, '').replace(/`/g, '').trim();

// 단어 경계에서 max자 이하로 자른다. 잘랐으면 끝에 …를 붙인다(…까지 max자 이하).
export function trimWords(s, max) {
  s = s.trim();
  if (s.length <= max) return s;
  // 문장 경계(". ", ", ")가 max 안에 있으면 그 앞까지
  const head = s.slice(0, max);
  const clause = Math.max(head.lastIndexOf('. '), head.lastIndexOf(', '));
  if (clause >= Math.min(6, max - 1)) return s.slice(0, clause).trim();
  const room = s.slice(0, max - 1);
  const sp = room.lastIndexOf(' ');
  const cut = sp >= Math.floor(max / 3) ? room.slice(0, sp) : room;
  return cut.replace(/[\s,.·/+→-]+$/, '') + '…';
}

// " / "로 나뉜 조정 문구를 max자 이하로 앞에서부터 담는다.
export function trimSegments(s, max) {
  s = s.trim();
  if (s.length <= max) return s;
  const parts = s.split(' / ');
  let out = '';
  for (const p of parts) {
    const next = out ? `${out} / ${p}` : p;
    if (next.length > max) break;
    out = next;
  }
  return out || trimWords(parts[0], max);
}

export function orderKeys(obj) {
  const out = {};
  for (const k of KEY_ORDER) if (obj[k] !== undefined) out[k] = obj[k];
  for (const k of Object.keys(obj)) if (!(k in out) && obj[k] !== undefined) out[k] = obj[k];
  return out;
}

// ---------- 표 ----------

export function splitRow(line) {
  const t = line.trim();
  if (!t.startsWith('|')) return null;
  return t.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => clean(c));
}

export const isSepRow = (cells) => cells.every((c) => /^:?-{2,}:?$/.test(c));

// 연속한 표 줄을 [{header, rows}]로 모은다.
export function tablesIn(lines) {
  const tables = [];
  let cur = null;
  for (const line of lines) {
    const cells = splitRow(line);
    if (!cells) { cur = null; continue; }
    if (!cur) { cur = { header: cells, rows: [] }; tables.push(cur); continue; }
    if (isSepRow(cells)) continue;
    cur.rows.push(cells);
  }
  return tables;
}

// ---------- 원두 파일 읽기 ----------

const COUNTRIES = ['콜롬비아', '코스타리카', '에티오피아', '케냐', '파나마', '과테말라', '브라질', '르완다', '부룬디',
  '온두라스', '엘살바도르', '니카라과', '페루', '볼리비아', '에콰도르', '멕시코', '인도네시아', '예멘', '탄자니아', '우간다',
  '중국', '인도', '베트남', '하와이', '자메이카'];
const PROCESS_WORDS = ['애너로빅', '무산소', '워시드', '내추럴', '레드 허니', '옐로 허니', '블랙 허니', '화이트 허니', '허니',
  '가향', '코퍼먼테이션', '더블 퍼먼테이션', '카보닉 마세레이션'];

function roasterOf(info) {
  const raw = info['로스터리'];
  if (!raw) return undefined;
  return clean(raw).split(/[(（.,]/)[0].trim() || undefined;
}

function shortBeanName(h1, info, roaster) {
  let s = h1 ? h1.replace(/^#\s*/, '').split(/\s+[—–-]\s+/)[0] : clean(info['상품명'] || '');
  const quoted = /["“]([^"”]+)["”]/.exec(s);
  if (quoted) s = quoted[1];
  else {
    if (roaster) {
      if (s.startsWith(roaster)) s = s.slice(roaster.length);
      else {
        const first = roaster.split(' ')[0];
        if (s.startsWith(first)) s = s.slice(first.length);
      }
    }
    s = s.replace(/\[[^\]]*\]/g, ' ')
      .replace(/\([^)]*\)/g, ' ')
      .replace(/#\d+/g, ' ')
      .replace(/\b\d+\s*[gG]\b/g, ' ')
      .replace(/Craft by .*/i, ' ');
    if (s.includes(',')) s = s.split(',').pop();
    for (const c of COUNTRIES) s = s.replace(new RegExp(`(^|\\s)${c}(?=\\s|$)`, 'g'), ' ');
  }
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > LIMIT.b) {
    for (const w of PROCESS_WORDS) s = s.replace(new RegExp(`(^|\\s)${w}(?=\\s|$)`, 'g'), ' ').replace(/\s+/g, ' ').trim();
  }
  while (s.length > LIMIT.b && s.includes(' ')) s = s.slice(0, s.lastIndexOf(' '));
  return s.slice(0, LIMIT.b);
}

function num(s) {
  const m = /-?\d+(?:\.\d+)?/.exec(s);
  return m ? Number(m[0]) : null;
}

function parseWater(cell) {
  const out = {};
  for (const seg of cell.split('+')) {
    const g = /(\d+(?:\.\d+)?)\s*g/.exec(seg);
    if (!g) continue;
    const v = Number(g[1]);
    if (/얼음/.test(seg)) out.i = v;
    else if (/바이패스|가수|추가 물/.test(seg)) out.p = v;
    else if (out.w === undefined) out.w = v;
  }
  return out;
}

function parseClicks(cell) {
  const m = /(\d+)\s*(?:[~–-]\s*(\d+)\s*)?클릭/.exec(cell);
  if (!m) return null;
  return m[2] ? [Number(m[1]), Number(m[2])] : Number(m[1]);
}

// 분쇄 칸의 ZP6 값이 환산식과 다를 때만(로스터리가 ZP6 값을 직접 준 경우, 예: 언더빈 5.0) 그 값을 넘긴다.
function zp6Given(cell, c) {
  const m = /ZP6\s*(\d\.\d(?:\s*~\s*\d\.\d)?)/.exec(cell);
  if (!m || c == null) return undefined;
  const z = m[1].replace(/\s/g, '');
  const [lo, hi] = Array.isArray(c) ? c : [c, c];
  return z === (lo === hi ? zp6Of(lo) : `${zp6Of(lo)}~${zp6Of(hi)}`) ? undefined : z;
}

function parseValve(v) {
  if (v === undefined) return null;
  if (/닫/.test(v)) return 0;
  if (/열/.test(v)) return 1;
  return null;
}

// 표준 블록 하나를 레시피 객체로. 실패하면 이유 문자열을 던진다.
function parseBlock(id, dripper, type, body, meta) {
  const tables = tablesIn(body);
  const info = tables.find((t) => t.header.includes('원두') && t.header.some((h) => h.startsWith('분쇄')));
  const steps = tables.find((t) => t.header.includes('시간') && t.header.includes('동작'));
  if (!info || !info.rows.length) throw new Error('원두/분쇄 표가 없다');
  if (!steps || !steps.rows.length) throw new Error('시간/동작 단계 표가 없다');

  const col = (t, pred) => t.header.findIndex(pred);
  const row = info.rows[0];
  const cell = (pred) => { const k = col(info, pred); return k < 0 ? '' : (row[k] || ''); };

  const g = num(cell((h) => h === '원두'));
  const grindCell = cell((h) => h.startsWith('분쇄'));
  const c = parseClicks(grindCell);
  const T = num(cell((h) => h.includes('온도')));
  const water = parseWater(cell((h) => h === '물'));
  const ra = cell((h) => h.startsWith('비율'));
  if (g == null) throw new Error('원두 g를 못 읽었다');
  if (c == null) throw new Error('코만단테 클릭을 못 읽었다');
  if (T == null) throw new Error('물 온도를 못 읽었다');
  if (water.w === undefined) throw new Error('물 g를 못 읽었다');

  const iTime = col(steps, (h) => h === '시간');
  const iValve = col(steps, (h) => h.startsWith('밸브'));
  const iCum = col(steps, (h) => h.startsWith('누적'));
  const iAct = col(steps, (h) => h === '동작');
  const s = steps.rows.map((r) => {
    const cumRaw = iCum < 0 ? '' : (r[iCum] || '');
    const cum = /\d/.test(cumRaw) ? num(cumRaw) : null;
    return [r[iTime] || '', iValve < 0 ? null : parseValve(r[iValve]), cum, trimWords(r[iAct] || '', LIMIT.act)];
  });

  const bullet = (re) => {
    for (const line of body) {
      const m = re.exec(clean(line.replace(/^\s*-\s*/, '')));
      if (/^\s*-\s/.test(line) && m) return m[1].trim();
    }
    return undefined;
  };
  let f = bullet(/^필터\s*:\s*(.+)$/);
  if (f) f = f.split(/\s\(|\.\s/)[0].trim();
  let tt = bullet(/^총 시간\s*:?\s*(.+)$/);
  if (tt) tt = tt.replace(/\([^)]*\)/g, '').replace(/^약\s*/, '').trim();
  let a = bullet(/^첫 잔 후 조정\s*:\s*(.+)$/);
  if (a) a = trimSegments(a, LIMIT.a);

  return orderKeys({
    b: meta.b, r: meta.r, d: dripper, t: type, g, c, z: zp6Given(grindCell, c), T,
    w: water.w, i: water.i, p: water.p, ra: ra || undefined, f, s, tt, a, id,
  });
}

// 원두 파일 텍스트 → { recipes, skips, default, defNote }
export function parseBeanText(text, opts = {}) {
  const lines = text.split(/\r?\n/);
  const h1 = lines.find((l) => /^#\s/.test(l));
  const info = {};
  for (const l of lines) {
    const cells = splitRow(l);
    if (cells && cells.length >= 2 && !(cells[0] in info)) info[cells[0]] = cells[1];
  }
  const r = roasterOf(info);
  const b = opts.name ? opts.name.slice(0, LIMIT.b) : shortBeanName(h1, info, r);
  const meta = { b, r };

  const recipes = [];
  const skips = [];
  let inRecipeSection = false;
  let cur = null;
  const flush = () => {
    if (!cur) return;
    if (cur.skip) skips.push({ id: cur.id, reason: cur.skip });
    else {
      try { recipes.push(parseBlock(cur.id, cur.d, cur.t, cur.body, meta)); }
      catch (e) { skips.push({ id: cur.id, reason: e.message }); }
    }
    cur = null;
  };
  for (const line of lines) {
    if (/^##\s/.test(line)) {
      flush();
      inRecipeSection = /^##\s+\d+\.\s*레시피/.test(line);
      continue;
    }
    if (!inRecipeSection) continue;
    const h3 = /^###\s+(\d+-\d+)\.\s+(.*)$/.exec(line);
    if (h3) {
      flush();
      const std = /^(.+?)\s+·\s+(ICE|HOT)\b/.exec(h3[2]);
      cur = std
        ? { id: h3[1], d: std[1].trim(), t: std[2], body: [] }
        : { id: h3[1], skip: `옛 불릿 형식 (제목에 "<드리퍼> · ICE|HOT" 없음: "${h3[2].slice(0, 40)}")`, body: [] };
      continue;
    }
    if (!cur) continue;
    if (/^---\s*$/.test(line) || /^첫 추천/.test(line)) { flush(); continue; }
    cur.body.push(line);
  }
  flush();

  const dm = /현재 기본값\s*:\s*(\d+-\d+)/.exec(text);
  let def = dm ? dm[1] : undefined;
  let defNote;
  if (def && !recipes.some((x) => x.id === def)) {
    defNote = `기본값 ${def}을 읽지 못해 대신 고른다`;
    def = undefined;
  }
  if (!def) def = (recipes.find((x) => x.t === 'ICE') || recipes[0] || {}).id;
  return { recipes, skips, default: def, defNote };
}

// ---------- 원두 라이브러리 ----------

// beans/ 안에서 원두 파일이 아닌 것
export const NON_BEAN = new Set(['TEMPLATE.md', 'INDEX.md', 'WISHLIST.md']);

// 로스팅 후 경과일 구간 (recipes/blends-and-bean-guide.md 5-2표)
export const AGE_STAGES = [
  [2, '0~2일', '가스가 가장 많아요. 2~3일 더 기다리면 좋아요'],
  [7, '3~7일', '미디엄·다크 적기. 라이트는 뜸을 40~45초로 길게'],
  [14, '8~14일', '라이트 적기. 레시피 그대로'],
  [21, '15~21일', '뜸 25~30초, 온도 +1℃, 1~2클릭 가늘게'],
  [30, '22~30일', '윗향이 꺾여요. 온도 +1~2℃, 2클릭 가늘게'],
  [Infinity, '31일 이상', '산화가 진행돼요. 온도 +2℃, 가늘게, 원두 +1~2g'],
];

// 원두 파일의 '로스팅일' 칸이 YYYY-MM-DD로 시작할 때만 계산한다. 미확인이거나 오늘보다 뒤면 null.
export function roastAge(text, now = new Date()) {
  const row = text.split(/\r?\n/).map(splitRow).find((c) => c && c[0] === '로스팅일');
  const m = row && /^(\d{4})-(\d{2})-(\d{2})/.exec(row[1] || '');
  if (!m) return null;
  const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - new Date(+m[1], m[2] - 1, +m[3])) / 86400000);
  if (!(days >= 0)) return null;
  const [, range, tip] = AGE_STAGES.find(([max]) => days <= max);
  return { date: m[0], days, range, tip, guess: /추정/.test(row[1]) };
}

// 원두 파일의 '판매 상태' 칸에서 확인일과 상태를 읽는다. 템플릿 자리표시나 형식이 다르면 null.
export function saleStatus(text) {
  const row = text.split(/\r?\n/).map(splitRow).find((c) => c && c[0] === '판매 상태');
  const cell = row && row[1] || '';
  if (/YYYY-MM-DD 확인\(근거\): 판매 중 \/ 품절 \/ 판매 종료/.test(cell)) return null;
  const date = /^(\d{4}-\d{2}-\d{2}) 확인/.exec(cell);
  const status = /:\s*(판매 중|품절|판매 종료|확인 못 함)/.exec(cell);
  return date && status ? { status: status[1], date: date[1] } : null;
}

// ---------- 그라인더 환산 ----------

// 코만단테 C40 클릭 → 1Zpresso ZP6 Special 눈금 "숫자.클릭" (예: 24 → "4.9" = 숫자 4에서 9클릭, 49클릭).
// ZP6 Special은 1클릭 22µm, 10클릭이 숫자 1이다(1Zpresso 공식 표). C40 날 간격(클릭 × 30µm)에 360µm를 더해 22µm로 나눈다.
// 360µm는 날 구조 차이(영점) 보정값으로, 공식 푸어오버 구간 4.0~5.0·1Zpresso 챔피언 레시피 4.1~5.6·언더빈 C40 21 = ZP6 5.0에 맞춘
// 편집자 환산이다(recipes/v60-switch.md '분쇄도 환산 기준').
export function zp6Of(c40) {
  const k = Math.round((c40 * 30 + 360) / 22);
  return `${Math.floor(k / 10)}.${k % 10}`;
}

// ---------- 브루 카드 ----------

export const isNum = (v) => typeof v === 'number' && isFinite(v);
const str = (v) => (v == null ? '' : String(v));

// 주소에서 푼 레시피 객체(FORMAT.md)를 카드 화면용 {o, steps}로 바꾼다. 모양이 틀리면 던진다.
export function cardOf(o) {
  if (!o || typeof o !== 'object' || !Array.isArray(o.s) || !o.s.length) throw new Error('bad');
  const steps = o.s.map((s) => {
    if (!Array.isArray(s)) throw new Error('bad step');
    return { label: str(s[0]).trim(), valve: s[1] === 0 || s[1] === 1 ? s[1] : null, g: isNum(s[2]) ? s[2] : null, act: str(s[3]) };
  });
  return { o, steps };
}

// 원두량 바꾸기: 물·얼음·바이패스·누적 g만 (g ÷ 원래 g) 비율로 바꾼다. 시각·분쇄·온도·비율 표기는 그대로.
export function scaleCard(c, g) {
  if (!isNum(c.o.g) || !isNum(g) || g === c.o.g) return c;
  const k = g / c.o.g, sc = (v) => (isNum(v) ? Math.round(v * k) : v);
  // 동작 문구 속 "+30g", "얼음 100g"도 같은 비율로 (안 바꾸면 오른쪽 누적 g와 어긋난다)
  // 맨 앞 "+Ng"는 반올림한 누적 g의 차이로 맞춘다.
  const act = (t) => t.replace(/(\d+(?:\.\d+)?)(\s*g)(?![a-zA-Z])/g, (m, n, u) => Math.round(n * k) + u);
  let prev = 0;
  const steps = c.steps.map((s) => {
    const g2 = sc(s.g);
    let a = act(s.act);
    if (isNum(g2) && isNum(prev) && /^\+\d/.test(a)) a = a.replace(/^\+\d+(?:\.\d+)?/, '+' + (g2 - prev));
    prev = g2;
    return { ...s, g: g2, act: a };
  });
  return { o: { ...c.o, g, w: sc(c.o.w), i: sc(c.o.i), p: sc(c.o.p) }, steps };
}
