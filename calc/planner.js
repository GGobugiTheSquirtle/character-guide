// 행동 계획기 (2026-10-17, plan ae-party-build E2) — 스킬칸 4개가 정해진 파티에서 AF 시전(캐릭터당 6회) · 일반 턴 행동을 고른다
//   점수 = scenario.run 의 점수(AF 면 AF 뒤 비AF 턴, 아니면 계획의 모든 턴). AF 대미지는 점수 밖이라 AF 공격은 행동 소모형 버프만 깎는다
//   시작 계획(휴리스틱) → 칸마다 「스킬칸 4개 + 안 씀」을 바꿔 보는 좌표 하강, 점수가 안 오르면 멈춤
//   브라우저(window.AEPlanner) · node 공용. 테스트: _tools/character/tests/test_planner.cjs(축소 공간 전수 대조)
(function (root) {
  "use strict";
  const S = root.AEScenario || require("./scenario.js");
  const ENGINE = new Set(["stat_pct", "dmg", "buff", "ailment", "stack"]);
  const skillOf = (m, name) => (m.actions.skills || []).find(s => s.name === name);
  const isSetup = sk => !!sk && !(sk.attacks || []).length && (sk.fx || []).some(u => ENGINE.has(u.k) && (!u.timing || u.timing === "use"));
  const isAttack = sk => !!sk && (sk.attacks || []).length > 0;

  // 시작 계획 — AF: 준비 스킬(공격 없이 엔진 효과)을 돌려 가며, 없으면 안 씀 / 턴: 혼자 쳤을 때 가장 센 공격, 공격이 없으면 준비 스킬
  function initial(party, opt, conf) {
    const solo = (ci, name) => S.run(party, { af: null, turns: [party.map((m, i) => (i === ci ? name : null))] }, opt).score;
    const af = conf.af ? party.map(m => {
      const setup = m.slots.filter(n => isSetup(skillOf(m, n)));
      return Array.from({ length: conf.afCasts }, (_, k) => (setup.length ? setup[k % setup.length] : null));
    }) : null;
    const pick = party.map((m, ci) => {
      const atks = m.slots.filter(n => isAttack(skillOf(m, n)));
      if (!atks.length) return m.slots.find(n => isSetup(skillOf(m, n))) || null;
      return atks.map(n => [n, solo(ci, n)]).sort((a, b) => b[1] - a[1])[0][0];
    });
    return { af, turns: Array.from({ length: conf.turns }, () => pick.slice()) };
  }

  // conf = { af: true, afCasts: 6, turns: 3, scoreTurns, passes: 4, restarts: 8, seed } → { plan, res, evals }
  //   좌표 하강은 덮어쓰기 · 순서(버프 뒤 공격) 때문에 국소 최적에 걸린다 → 시작 계획 + 시드 고정 무작위 시작 restarts 개 중 가장 좋은 것
  function plan(party, opt, conf = {}) {
    conf = { af: true, afCasts: 6, turns: 3, passes: 4, restarts: 8, seed: 7, ...conf };
    let rnd = conf.seed >>> 0 || 1;
    const rand = () => (rnd = (Math.imul(rnd, 1664525) + 1013904223) >>> 0) / 4294967296;
    const pickR = m => { const o = [...m.slots, null]; return o[Math.floor(rand() * o.length)]; };
    const base = conf.start || initial(party, opt, conf);
    const starts = [base];
    for (let i = 0; i < conf.restarts; i++)
      starts.push({ af: base.af && party.map(m => Array.from({ length: conf.afCasts }, () => pickR(m))), turns: base.turns.map(row => row.map((x, ci) => pickR(party[ci]))) });
    let top = null, evals = 0;
    conf = { ...conf, memo: conf.memo || new Map() };                     // 재시작끼리도 메모 공유(장비 · 파티가 같다)
    for (const st of starts) {
      const r = descend(party, opt, conf, st);
      evals += r.evals;
      if (!top || r.score > top.score) top = r;
    }
    return { ...top, evals };
  }
  function descend(party, opt, conf, start) {
    const scoreTurns = conf.scoreTurns || (conf.af ? Array.from({ length: conf.turns }, (_, i) => i + 2) : Array.from({ length: conf.turns }, (_, i) => i + 1));
    let p = start, evals = 0;
    const memo = conf.memo || new Map();                                  // 같은 상태의 대미지는 한 번만(scenario attack 메모)
    const score = q => { evals++; return S.run(party, q, opt, { scoreTurns, memo }).score; };
    let best = score(p);
    const cells = [];
    if (p.af) party.forEach((m, ci) => { for (let k = 0; k < conf.afCasts; k++) cells.push(["af", ci, k]); });
    for (let t = 0; t < conf.turns; t++) party.forEach((m, ci) => cells.push(["turns", t, ci]));
    for (let pass = 0; pass < conf.passes; pass++) {
      let moved = false;
      for (const [kind, a, b] of cells) {
        const m = kind === "af" ? party[a] : party[b];
        const cur = p[kind][a][b];
        for (const opt2 of [...m.slots, null]) {
          if (opt2 === cur) continue;
          const q = { af: p.af && p.af.map(r => r.slice()), turns: p.turns.map(r => r.slice()) };
          q[kind][a][b] = opt2;
          const s = score(q);
          if (s > best * (1 + 1e-9)) { best = s; p = q; moved = true; }
        }
      }
      // 바꿔치기 — 멤버의 「스킬 X 를 쓰던 칸 전부」를 Y 로. 칸 하나씩은 매번 손해인 이동(덮어쓰기 · 누적 전환)을 넘는다
      party.forEach((m, ci) => {
        const opts = [...m.slots, null];
        for (const x of opts) for (const y of opts) {
          if (x === y) continue;
          const q = { af: p.af && p.af.map(r => r.slice()), turns: p.turns.map(r => r.slice()) };
          let hit = false;
          if (q.af) q.af[ci] = q.af[ci].map(v => (v === x ? (hit = true, y) : v));
          q.turns.forEach(r => { if (r[ci] === x) { r[ci] = y; hit = true; } });
          if (!hit) continue;
          const s = score(q);
          if (s > best * (1 + 1e-9)) { best = s; p = q; moved = true; }
        }
      });
      if (!moved) break;
    }
    return { plan: p, res: S.run(party, p, opt, { scoreTurns }), score: best, evals };
  }

  const api = { plan, initial, isSetup, isAttack };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AEPlanner = api;
})(typeof window !== "undefined" ? window : globalThis);
