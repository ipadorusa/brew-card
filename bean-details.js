// 원두 화면 전용 메타데이터. QR 레시피 객체에는 넣지 않는다.
import { splitRow, tablesIn, roastAge } from './brew-core.js';

export function recipeEvidence(text) {
  const sources = [];
  const result = {};
  let sourceSection = false, recipeSection = false, sectionBasis = '', current = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^##\s/.test(line)) {
      sourceSection = /^##\s+(?:\d+\.\s*)?(?:참고\s*)?출처/.test(line);
      recipeSection = /^##\s+\d+\.\s*레시피/.test(line);
      sectionBasis = recipeSection && /모두 로스터리 권장 기반/.test(line) ? line.replace(/^##\s+/, '') : '';
      current = null;
    }
    if (sourceSection && /^\s*-\s/.test(line)) sources.push(line);
    if (!recipeSection) continue;
    const heading = /^###\s+(\d+-\d+)\.\s+.*?·\s*(?:HOT|ICE)\b(.*)$/.exec(line);
    if (heading) {
      const basis = (heading[2].match(/\[(.*)\]/) || [])[1] || sectionBasis;
      current = { label: /로스터리 권장 기반/.test(basis) ? '로스터리 권장 기반' : /기반:|일반 레시피 응용|^SPIN 밸브/.test(basis) ? '일반 레시피 응용' : '근거 구분 미기재', basis, reason: '', sources };
      result[heading[1]] = current;
    }
    if (!current) continue;
    const reason = /^\s*-\s*이 원두에 맞춘 이유:\s*(.+)/.exec(line);
    if (reason) current.reason = reason[1];
  }
  return result;
}

// 브루 카드 고르기용: 드리퍼 묶음(family)과 그 안의 종류(variant).
// V60 · V60 Switch · V60 네오 스위치는 "V60" 묶음, SOLO와 SPIN 밸브 레시피(제목 대괄호가 "SPIN 밸브 ·"로 시작)는 "SOLO" 묶음이다.
// 카드 주소의 d(드리퍼 표기)는 그대로 두고 화면에서만 나눈다.
export function dripperChoice(recipe, basis = '') {
  const d = String(recipe?.d || '');
  const isSolo = /^SOLO(\s|$)/.test(d);
  const family = /^V60(\s|$)/.test(d) ? 'V60' : isSolo ? 'SOLO' : d;
  const variant = isSolo && /^SPIN 밸브/.test(basis || '') ? 'SOLO SPIN' : d;
  return { family, variant };
}

export function validDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(+date) && date.toISOString().slice(0, 10) === value;
}

export const BAG_COLUMNS = ['봉투 ID', '구매일', '로스팅일', '중량(g)', '가격(원)', '구매처', '메모'];

export function bagHistory(text) {
  const lines = text.split(/\r?\n/);
  const info = lines.map(splitRow).find((r) => r?.[0] === '로스팅일');
  const legacy = { id: 'legacy', purchased: '-', roast: info?.[1] || '미확인', weight: '-', price: '-', shop: '-', note: '기존 원두 정보' };
  const start = lines.findIndex((l) => /^##\s+봉투 이력\s*$/.test(l));
  if (start < 0) return { bags: [legacy], current: legacy.id, errors: [], start, end: lines.length };
  const next = lines.slice(start + 1).findIndex((l) => /^##\s/.test(l));
  const end = next < 0 ? lines.length : start + 1 + next;
  const section = lines.slice(start + 1, end);
  const table = tablesIn(section)[0];
  const errors = [];
  if (!table || BAG_COLUMNS.some((c, k) => table.header[k] !== c) || table.header.length !== BAG_COLUMNS.length) errors.push('봉투 이력 표의 머리글을 확인해 주세요.');
  const bags = [], ids = new Set();
  for (const row of table?.rows || []) {
    const [id, purchased, roast, weight, price, shop, note] = row;
    if (row.length !== BAG_COLUMNS.length) errors.push(`봉투 ${id || '?'}: 표의 칸 수가 맞지 않아요.`);
    if (!/^[a-zA-Z0-9][\w.-]*$/.test(id || '') || ids.has(id)) errors.push(`봉투 ID ${id || '?'}가 잘못됐거나 중복돼요.`);
    ids.add(id);
    for (const value of [purchased, roast]) {
      if (value && value !== '-' && !/^미확인(?:$|[ .(])/.test(value) && !(validDate(value.slice(0, 10)) && /^(\d{4}-\d{2}-\d{2})(?:$|\s)/.test(value))) errors.push(`봉투 ${id}: 날짜 ${value}를 확인해 주세요.`);
    }
    if (weight && weight !== '-' && !(Number.isFinite(Number(weight)) && Number(weight) > 0)) errors.push(`봉투 ${id}: 중량을 확인해 주세요.`);
    if (price && price !== '-' && !(Number.isFinite(Number(price)) && Number(price) >= 0)) errors.push(`봉투 ${id}: 가격을 확인해 주세요.`);
    bags.push({ id, purchased, roast, weight, price, shop, note });
  }
  const current = (section.join('\n').match(/^현재 봉투:\s*(\S+)\s*$/m) || [])[1];
  if (current && current !== '-' && !ids.has(current)) errors.push(`현재 봉투 ${current}가 이력에 없어요.`);
  return { bags: bags.length ? bags : [legacy], current: ids.has(current) ? current : bags.at(-1)?.id || legacy.id, errors, start, end };
}

export function bagAge(bag, now = new Date()) {
  if (!validDate((bag?.roast || '').slice(0, 10))) return null;
  return roastAge(`| 로스팅일 | ${bag?.roast || ''} |`, now);
}
