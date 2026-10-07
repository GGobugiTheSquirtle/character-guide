// 원작 어나더에덴 대미지 · 버프 중첩 엔진 (2026-10-07)
//   정본: docs/ae-damage-formula.md §2 + anothereden.wiki Damage Formula · Template:DMG Formula · Damage Formula/Multipliers
//   브라우저(window.AECalc)와 node(require) 공용. 테스트: _tools/character/tests/test_ae_calc.cjs
//   값 표기: 퍼센트는 전부 분수(+50% = 0.5). 스탯은 정수.
(function (root) {
  "use strict";

  // ── 중첩 규칙 (Damage Formula/Multipliers 「Types of stacking」) ──────────────────────
  // 체감: 1 + A + A·B + A·B·C … (큰 값부터). 반환은 추가분(분수)
  function diminish(vals) {
    let tot = 0, prod = 1;
    for (const x of vals.filter(v => v > 0).sort((a, b) => b - a)) { prod *= x; tot += prod; }
    return tot;
  }
  // 중첩형 스킬 버프: A + A/2 + A/2 … (n 중첩). 예외(러블리 · 키쿄)는 ratio 로
  function halfStack(a, n, ratio = 0.5) { return n > 0 ? a + a * ratio * (n - 1) : 0; }
  const sum = xs => xs.reduce((s, x) => s + x, 0);
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

  // 한 그룹(같은 이름 · 아이콘)의 순효과 — 버프 체감 − 디버프 체감, ±cap
  //   g = { buffs:[], debuffs:[], stacks:[{v,n,ratio}], named:[], namedDown:[], equip:[], cap:1 }
  //   · 중첩형 스킬 버프는 반감 합을 한 값으로, 고유 축적(named)은 가산 합을 한 값으로 체감에 넣는다
  //   · 장비(E 아이콘)는 가산 합의 순값을 부호에 따라 버프 또는 디버프 쪽 한 값으로(위키 저항 예제)
  function groupNet(g) {
    const up = [...(g.buffs || [])], down = [...(g.debuffs || [])];
    for (const s of g.stacks || []) up.push(halfStack(s.v, s.n, s.ratio));
    if ((g.named || []).length) up.push(sum(g.named));
    if ((g.namedDown || []).length) down.push(sum(g.namedDown));
    const eq = sum(g.equip || []);
    if (eq > 0) up.push(eq); else if (eq < 0) down.push(-eq);
    const cap = g.cap ?? 1;
    return clamp(diminish(up) - diminish(down), -cap, cap);
  }
  // 가산 그룹(크리율 · 크리 대미지 · 장비 대미지 UP · 약점 배율 버프): 상한 없음
  const additive = vals => sum(vals || []);

  // 정신 통일 · 매의 눈 · 하극상: 각자 상한(정신 통일 +250%) 뒤 서로 체감, 합 상한 +350%
  function focusGroup(vals, eachCap = 2.5, cap = 3.5) {
    return Math.min(cap, diminish(vals.map(v => Math.min(v, eachCap))));
  }
  // 정신 통일 한 출처: 최대 MP × 비율(+0.23%/MP 가 보통) — 같은 캐릭터에 여러 출처면 체감, 상한 +250%
  function mentalFocus(maxMp, rates) { return Math.min(2.5, diminish(rates.map(r => maxMp * r))); }

  // 스킬 배율 — 다단은 타수로 나눠 올림(190% 3타 → 64% × 3)
  function perHitMult(totalPct, hits) { return Math.ceil(totalPct / hits); }

  // ── 대미지 (Template:DMG Formula 5변형) ────────────────────────────────────────
  const RAND = { phys: [16, 47], magic: [32, 94] };
  const elemMod = x => (Math.sqrt(x * 10 + 16) - 4) / 64 + 1;
  const physWeak = b => (b + Math.sqrt(2 * b)) / 512 + 1.85;

  // o = {
  //   dep: 'pwr' | 'spd' | 'int' (물리) | 'magic' | 'magicpwr',
  //   elemental: bool,                       속성 공격이면 ElementalMod 적용
  //   stat: {pwr, int, spd}                  _base = 장비 · 배지 · 그라스타 포함, 전투 버프 제외
  //   weapon: {atk, matk}, stacks: {pwr, int, spd}  고정치 축적(Tea Energy +7 Atk 등)
  //   buff: {pwr, int, spd}                  전투 중 % 순효과(groupNet 결과)
  //   enemy: {def, mdef}, affinity: 'norm'|'weak'|'resist'|'null'|'absorb', af: bool
  //   crit: bool, critDmg: 분수(크리 대미지 UP 가산 합 — 크리일 때만), weakBuff: 분수(약점 배율 가산)
  //   skillMult: 분수(2.0 = 200%), skillFx: [분수](스킬 자체 위력 · 곱), zone: 분수(+30% = .3, −30% = −.3)
  //   resDown: {type, phys, magic}          적 저항 순감(+면 적이 더 받음) — 공격 종류에 맞는 것만 더한다
  //   groups: [분수]                         버프 그룹들(속성 공격 · 무기 대미지 · 정신 통일 …) 각자 (1+x) 곱
  //   punish: 정수(조건 맞는 페인 · 독 그라스타 수, 각 ×1.3), equip: [분수](E 아이콘 장비 대미지 UP 가산)
  //   single: bool(단일 · 랜덤 대상 스킬 ×1.1), rand: 'min'|'avg'|'max'
  // }
  function damage(o) {
    const st = o.stat || {}, w = o.weapon || {}, sk = o.stacks || {}, bf = o.buff || {};
    const dep = o.dep || "pwr";
    const magic = dep === "magic" || dep === "magicpwr";
    const crit = !!o.crit;
    const pct = k => 1 + (bf[k] || 0);
    const ATK = (st.pwr || 0) + (w.atk || 0), MATK = (st.int || 0) + (w.matk || 0);
    let atkTerm, scale, eleX, def, weakB;
    if (dep === "pwr") {
      atkTerm = (ATK + (sk.pwr || 0)) * pct("pwr"); scale = (st.pwr || 0) / 32 + 1; eleX = MATK;
      def = o.enemy.def; weakB = ((st.int || 0) + (sk.int || 0)) * pct("int") + (w.matk || 0);
    } else if (dep === "spd") {
      const s = ((st.spd || 0) + (sk.spd || 0)) * pct("spd");
      atkTerm = ((st.spd || 0) + (w.atk || 0) + (sk.spd || 0)) * pct("spd"); scale = s / 32 + 1; eleX = MATK;
      def = o.enemy.def; weakB = s + (w.matk || 0);
    } else if (dep === "int") {
      atkTerm = (MATK + (sk.int || 0)) * pct("int"); scale = (st.int || 0) / 32 + 1; eleX = st.int || 0;
      def = o.enemy.def; weakB = ((st.int || 0) + (sk.int || 0)) * pct("int");
    } else if (dep === "magic") {
      atkTerm = (MATK + (sk.int || 0)) * pct("int"); scale = (st.int || 0) / 32 + 1; eleX = st.int || 0;
      def = o.enemy.mdef;
    } else {                                          // magicpwr
      atkTerm = (ATK + (sk.pwr || 0)) * pct("pwr"); scale = (st.pwr || 0) / 32 + 1; eleX = st.int || 0;
      def = o.enemy.mdef;
    }
    const base = (atkTerm - def / (crit ? 4 : 2)) * scale * (crit ? 3.25 : 1.75);
    const ele = o.elemental ? elemMod(eleX) : 1;
    const core = Math.max(1, base * ele);
    const [r0, r1] = magic ? RAND.magic : RAND.phys;
    const r = o.rand === "min" ? r0 : o.rand === "max" ? r1 : (r0 + r1) / 2;
    const spread = atkTerm * r / 25.6;

    const aff = o.affinity || "norm";
    let res = 1;
    if (aff === "resist") res = 0.25;
    else if (aff === "null") res = 0;
    else if (aff === "weak") res = (magic ? 2 : physWeak(weakB)) + (o.weakBuff || 0);
    else if (aff === "absorb") res = (o.af && (dep === "pwr" || dep === "magic")) ? 0 : -0.5;

    const rd = o.resDown || {};
    const resSum = clamp((o.elemental ? (rd.type || 0) : 0) + (magic ? (rd.magic || 0) : (rd.phys || 0)), -2, 2);
    let total = (core + spread) * res;
    total *= o.skillMult ?? 1;
    for (const x of o.skillFx || []) total *= 1 + x;
    total *= 1 + (o.zone || 0);
    total *= 1 + resSum;
    for (const x of o.groups || []) total *= 1 + x;
    total *= Math.pow(1.3, o.punish || 0);
    total *= 1 + additive(o.equip);
    if (o.single) total *= 1.1;
    if (crit) total *= 1 + (o.critDmg || 0);
    return { total, parts: { atkTerm, base, ele, core, spread, res, resSum } };
  }

  // 회복 (Healing Formula · 얼티마니아 p.367): S/M/L/XL = 80/110/150/200%
  function heal(o) {
    const i = (o.int || 0) * (1 + (o.intBuff || 0)), m = o.matk || 0;
    const root2 = Math.sqrt((i + m) * 2);
    const r = o.rand === "min" ? 56 : o.rand === "max" ? 71 : 63.5;
    return ((i / 64 + 1) * root2 * 6.5 + root2 * r / 5.12) * (o.skillMult ?? 1);
  }

  // 크리 확률: 물리 LCK/16 % + 크리율 가산 / 마법은 마법 크리율 버프만
  function critChance(o) {
    return clamp(o.magic ? (o.mcritRate || 0) : (o.lck || 0) / 16 / 100 + (o.critRate || 0), 0, 1);
  }

  const api = { diminish, halfStack, groupNet, additive, focusGroup, mentalFocus, perHitMult, elemMod, physWeak,
    damage, heal, critChance };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AECalc = api;
})(typeof window !== "undefined" ? window : globalThis);
