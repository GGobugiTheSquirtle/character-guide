// 원작 어나더에덴 대미지 — 정밀 파이프라인(단계 순서 · 소수점 버림 · 감쇠 연산) (2026-10-13)
//   근거: 딩님 「AE 대미지 계산기 v4.003」의 계산 순서 · 실험 규칙을 해독한 것(docs/ae-damage-pipeline.md). 크레딧은 딩님.
//   ae_calc.js(위키 공식 · 평균 근사)와 같은 본식이고, 여기는 난수 값마다 정수 대미지를 그대로 낸다.
//   테스트: _tools/character/tests/test_ae_pipeline.cjs (엑셀 재계산 오라클과 정수 일치)
//   브라우저(window.AEPipe) · node 공용
(function (root) {
  "use strict";

  // 엑셀 ROUNDDOWN/ROUNDUP — 0 방향 버림 · 0 반대 방향 올림. 엑셀처럼 유효숫자 15자리로 맞춘 뒤 자른다(…99999 오차 흡수)
  const s15 = v => Number(v.toPrecision(15));
  function rd(x, n = 0) { const p = 10 ** n; return Math.trunc(s15(x * p)) / p; }
  function ru(x, n = 0) { const p = 10 ** n, v = s15(x * p); return (v > 0 ? Math.ceil(v) : Math.floor(v)) / p; }
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const arr = a => (a || []).filter(v => v !== null && v !== undefined);
  const sum = a => arr(a).reduce((s, v) => s + v, 0);

  // 감쇠 연산(특수 연산) — 큰 값부터 A, A×B, A×B×C …(매 곱마다 소수 둘째 자리 버림)의 합.
  //   음수(디버프)는 양수 다음 칸에서: 첫 음수는 그 값 그대로, 다음부터 직전 항 × |값|. 반환은 % 합
  //   vals = 채운 칸만(빈 칸은 세지 않는다 — 0 은 채운 칸이다), m = 항 수(칸 수)
  function decayTerms(vals, m) {
    const v = arr(vals), n = v.length, pos = v.filter(x => x > 0).length;
    const L = k => [...v].sort((a, b) => b - a)[k - 1], S = k => [...v].sort((a, b) => a - b)[k - 1];
    const t = [];
    for (let k = 1; k <= m; k++) {
      if (n < k) { t.push(0); continue; }
      if (k === 1) { t.push(pos >= 1 ? rd(L(1), 2) : rd(S(1), 2)); continue; }
      const prev = t[k - 2];
      if (pos >= k) t.push(rd(prev * rd(L(k), 2) / 100, 2));
      else t.push(rd(pos === k - 1 ? S(1) : prev * -1 * rd(S(k - pos), 2) / 100, 2));
    }
    return sum(t);
  }
  const decay = (vals, lo = -100, hi = 100) => 1 + clamp(decayTerms(vals, 4), lo, hi) / 100;
  const flat = a => sum(arr(a).map(x => rd(x, 0)));                      // 고정값 U/D 칸
  const pc = x => 1 + rd(x || 0, 2) / 100;                                // 「1 + %」 한 칸
  const pcSum = a => 1 + sum(arr(a).map(x => rd(x, 2))) / 100;            // 칸을 더해 한 배율
  const addR = (v, m) => v + rd(v * (m - 1), 0);                          // 증감분 버림 후 가산
  const seq = (v, ms) => arr(ms).reduce((x, m) => addR(x, pc(m)), v);    // 칸마다 차례로

  const KIND = {   // dmg: 물리 · 마법 · 회복 · 치유, scale: 기본 대미지 배율 스탯, atk: 공격 쪽, ele: 속성 배율 기준, weak: 상성 기준
    phys: { dmg: "phys" }, int_phys: { dmg: "phys" }, spd_phys: { dmg: "phys" }, pain: { dmg: "phys", dot: true },
    magic: { dmg: "magic" }, pwr_magic: { dmg: "magic" }, spd_magic: { dmg: "magic" }, poison: { dmg: "magic", dot: true },
    heal: { dmg: "heal" }, regen: { dmg: "regen" },
  };
  const SEEDS = { phys: [16, 47], magic: [32, 94], heal: [56, 71], regen: [56, 71] };

  // inp = {
  //   caster: 'ally'|'enemy', kind: KIND 키, power(%), scope: 'single'|'all', elemental: bool, affinity: 'norm'|'weak'|'resist'|'null'|'absorb',
  //   stats: { mp, atk(힘+무기), matk(지능+무기), pwr, int, spd }, enemy: { lv, def, mdef }, cap: true(25억 경감 — 기본 켬),
  //   fx: { 아래 키 — 배열은 채운 칸만(최대 4, 순서 = 계산 순서) }
  // }
  function compute(inp) {
    const f = inp.fx || {}, s = inp.stats, e = inp.enemy, K = KIND[inp.kind];
    const fl = f.flat || {}, pt = f.pct || {};
    const V = { mp: decay(pt.mp), pwr: decay(pt.pwr), int: decay(pt.int), spd: decay(pt.spd), def: decay(pt.def), mdef: decay(pt.mdef) };
    const st = (base, k) => base + flat(fl[k]) + rd((base + flat(fl[k])) * (V[k] - 1), 0);   // 상태 효과 적용 스탯
    const k = inp.kind, ally = inp.caster !== "enemy";
    const pwrK = ["phys", "pwr_magic", "pain"].includes(k), intK = ["magic", "int_phys", "poison"].includes(k), spdK = ["spd_phys", "spd_magic"].includes(k);
    // 스케일 스탯(아군은 상태 효과 제외 — 적은 적용), 공격 스탯, 속성 배율 기준, 상성(약점 배율) · 회복 기준
    const x3 = pwrK ? s.pwr : intK ? s.int : spdK ? st(s.spd, "spd") : 0;
    const x4 = pwrK ? st(s.pwr, "pwr") : (intK || K.dmg === "heal" || K.dmg === "regen") ? st(s.int, "int") : spdK ? st(s.spd, "spd") : 0;
    const x5 = pwrK ? st(s.atk, "pwr") : intK ? st(s.matk, "int") : spdK ? st(s.atk - s.pwr + s.spd, "spd") : 0;
    const x6 = ["phys", "spd_phys"].includes(k) ? s.matk : ["magic", "pwr_magic", "spd_magic", "int_phys"].includes(k) ? s.int : 0;
    const x7 = ["phys", "heal", "regen"].includes(k) ? st(s.int, "int") + s.matk - s.int : k === "int_phys" ? st(s.int, "int")
      : spdK ? st(s.spd, "spd") + s.matk - s.int : 0;
    const def = K.dmg === "phys" ? st(e.def, "def") : st(e.mdef, "mdef");
    const scale = 1 + (ally ? x3 : x4) / 32;
    const isDmg = K.dmg === "phys" || K.dmg === "magic";
    const baseN = isDmg ? (x5 - def / 2) * scale * 1.75 : (1 + x4 / 64) * Math.sqrt(2 * x7) * 6.5;
    const baseC = isDmg ? (x5 - def / 4) * scale * 3.25 : 0;
    const eleM = 1 + (inp.elemental ? (ru(Math.sqrt((ally ? x6 : st(x6, "int")) * 10 + 16), 5) - 4) / 64 : 0);

    // 배율 칸들
    const powerM = arr(f.power).reduce((p, x) => rd(p * pc(x), 0), rd(inp.power, 0)) / 100;
    const AFF = { norm: 1, resist: 0.25, null: 0, absorb: 0.5 };
    const affM = rd(K.dot || !isDmg ? 1 : inp.affinity === "weak"
      ? (K.dmg === "magic" ? 2 : 1.85 + (x7 + Math.sqrt(2 * x7)) / 512) + sum(f.weak) / 100 : AFF[inp.affinity], 4);
    const resPM = 1 - clamp(decayTerms(f.resPhysMag, 4), -100, 100) / 100;          // (대상) 물리/마법 저항 증감 — +면 적이 더 받음
    const resTM = 1 - (inp.elemental ? clamp(decayTerms(f.resType, 4), -100, 100) / 100 : 0);
    const mpTot = st(s.mp, "mp");
    const six = [0, 1].map(i => Math.min(250, mpTot * rd((f.focus || [])[i] || 0, 2)))   // 정신 통일 · 심기일체 = 최대 MP × 비율(칸당 ≤250)
      .concat([0, 1].map(i => rd((f.hawk || [])[i] || 0, 2)))                           // 호시탐탐
      .concat([0, 1].map(i => { const d = (f.overthrowNE || [])[i]; return Math.min(100, rd(d ? e.lv * e.lv / d : 0, 2)); }));   // 하극상 Lv²/d
    const stateNE = 1 + clamp(decayTerms(six, 6), -100, 350) / 100;
    const otE = [0, 1].map(i => { const d = (f.overthrowE || [])[i]; return rd(d ? e.lv * e.lv / d : 0, 2); });
    const stateE = 1 + decayTerms(otE, 2) / 100;
    const combo = f.combo ? f.combo / 100 : 1;
    const sx = x => arr(x).map(v => rd(v, 2) / 100);

    function one(seed, crit) {
      const ah = isDmg ? x5 * seed / 25.6 : Math.sqrt(2 * x7) * seed / 5.12;
      const aj = rd(ah === 0 ? 0 : (Math.max(1, (crit ? baseC : baseN) * eleM) + ah) * powerM, 0);
      let v = rd(aj * affM, 0);                                                    // 상성
      v = v + rd(v * (resPM - 1), 0) + rd(v * (resTM - 1), 0);                     // 저항 — 두 증감분을 각각 버림
      v = k === "heal" ? aj : addR(v, decay(f.typeNE));                            // (NE) 속성/무속성 대미지
      v = addR(v, stateNE);                                                        // (NE) 정신 통일 · 심기일체 · 호시탐탐 · 하극상
      v = addR(v, decay(f.wielder));                                               // (Buff) 장착자 대미지
      v = rd(v * combo, 0);                                                        // 콤보
      { const b = v; v = b + rd(b * sum(sx(f.typeE)), 0); for (const h of [...sx(f.hpE), ...sx(f.normalE)]) v += rd(b * h, 0); }   // (E) 속성 · HP 수준 · 일반 공격
      v = v + rd(v * sum(sx(f.healE)), 0);                                         // (E) 회복 스킬 효과
      v = seq(v, f.statusNE); v = seq(v, f.statusE); v = seq(v, f.enhance);        // 특공(NE) · 특공(E) · 인핸스
      v = addR(v, pcSum(f.fallen));                                                // 쓰러진 아군
      v = seq(v, f.condE);                                                         // (E) 공격 대미지 UP(MP 소비 · 적 수 …)
      v = addR(v, pc(f.kesshi)); v = addR(v, pc(f.shingan));                       // 결사 · 심안
      v = seq(v, f.condNB);                                                        // (스킬 자체) 가하는 대미지
      if (crit) { v = addR(v, pcSum(f.critDmg)); v = addR(v, pc(f.overCrit)); }   // 크리 위력 · 오버 크리
      v = addR(v, pc(f.aim)); v = addR(v, pcSum(f.zoneAwake)); v = addR(v, pcSum(f.zoneCond)); v = addR(v, pcSum(f.lsAlly));
      v = addR(v, stateE);                                                         // (E) 하극상
      { const b = v; for (const g of sx(f.growthAtk)) v += rd(b * g, 0); }         // 성장(공격)
      { const b = v; for (const g of sx(f.growthHit)) v += rd(b * g, 0); }         // 성장(피격)
      v = addR(v, pc(f.wins)); v = addR(v, pcSum(f.zone));                         // 누계 승리 · ZONE
      v = seq(v, f.cheer);                                                         // 가창 · 기도 · 환경
      v = addR(v, decay(f.aura));                                                  // 오라
      const ce = v;
      v = rd(v * pc(f.barrier), 0);                                                // 배리어
      if (inp.scope === "single") v = addR(v, 1.1);
      v = addR(v, pc(f.break));
      v = K.dot ? aj : addR(v, pc(f.decoy));                                       // 방패막이 — 독 · 페인은 여기서 기본값으로
      v = rd(v * pc(f.critGuard), 0);
      if (K.dot) v = seq(v, f.dot);                                                // 독 · 페인 대미지 UP
      if (v <= rd(f.zeroBelow || 0, 0)) v = 0;
      if (inp.cap !== false && v >= 2.5e9) v = v < 3.5e9 ? 1.75e9 + rd(v * 0.3, 0) : v < 5e9 ? 2.45e9 + rd(v * 0.1, 0)
        : v < 1e10 ? 2.8e9 + rd(v * 0.03, 0) : v < 7e11 ? 3e9 + rd(v * 0.01, 0) : 9999999999;
      return Math.max(0, K.dot && crit ? 0 : k === "heal" ? ce : k === "regen" ? aj : v);
    }
    const [a, b] = SEEDS[K.dmg], seeds = Array.from({ length: b - a + 1 }, (_, i) => a + i);
    const normal = seeds.map(x => one(x, false));
    const crit = isDmg ? (K.dmg === "phys" ? seeds : seeds).map(x => one(x, true)) : [];
    const avg = xs => xs.length ? xs.reduce((p, q) => p + q, 0) / xs.length : 0;
    return { dmg: K.dmg, normal, crit, avg: avg(normal), critAvg: avg(crit), parts: { x3, x4, x5, x6, x7, def, baseN, baseC, eleM, powerM, affM } };
  }

  const api = { compute, decayTerms, rd, ru };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AEPipe = api;
})(typeof window !== "undefined" ? window : globalThis);
