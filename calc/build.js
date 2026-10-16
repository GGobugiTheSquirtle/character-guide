// 파티 빌드 최적화 (2026-10-17, plan ae-party-build O1) — 캐릭터 조합 고정 → 스킬칸 4개 · AF 계획 · 점수 3종
//   주 점수 A = AF(캐릭터당 6회) 뒤 비AF 3턴(T2~T4) 대미지 합 / 보조 B = AF 없이 1턴 / C = AF 없이 3턴 — 사용자 선택(10-17)
//   스킬칸: 멤버마다 칸 하나를 후보로 바꿔 보는 좌표 하강. 바꿀 때는 현재 계획에서 그 스킬만 갈아 끼운 계획으로 시작해 짧게 다듬는다(planner start)
//   장비는 다음 단계(같은 파일에 붙인다) — 지금은 멤버에 낀 장비 그대로
//   브라우저(window.AEBuild) · node 공용. 테스트: _tools/character/tests/test_build.cjs
(function (root) {
  "use strict";
  const S = root.AEScenario || require("./scenario.js");
  const PL = root.AEPlanner || require("./planner.js");
  const ENGINE = new Set(["stat_pct", "dmg", "buff", "ailment", "stack", "zone"]);
  const useful = sk => (sk.attacks || []).length > 0 || (sk.fx || []).some(u => ENGINE.has(u.k) && (!u.timing || u.timing === "use"));
  // 스킬칸 후보 — 쓸모 있는 스킬칸 스킬. 장비 습득 스킬은 conf.equipSkills, 자원 소비(구슬 · 카운트 · 게이지, s.needs)는 conf.cond 일 때만
  //   — 그 자원을 모으는 흐름은 시나리오가 아직 모른다(해방 영랑지처럼 아무 때나 쓰면 4.9배 과대, 10-17)
  function candidates(m, conf = {}) {
    return (m.actions.skills || []).filter(s => s.slot && useful(s) && (!s.needEquip || conf.equipSkills) && (!s.needs || conf.cond)).map(s => s.name);
  }
  // 시작 스킬칸 — 준비 스킬(엔진 효과 수 많은 순) 2 + 공격(1회 위력 × 타수 큰 순) 2, 모자라면 나머지로
  function initialSlots(m, conf) {
    const cand = candidates(m, conf).map(n => m.actions.skills.find(s => s.name === n));
    const power = s => Math.max(0, ...(s.attacks || []).map(a => (a.power ?? a.mult ?? 0) * (a.hits || 1)));
    const setup = cand.filter(s => !(s.attacks || []).length).sort((a, b) => b.fx.filter(u => ENGINE.has(u.k)).length - a.fx.filter(u => ENGINE.has(u.k)).length);
    const atk = cand.filter(s => (s.attacks || []).length).sort((a, b) => power(b) - power(a));
    const pick = [...setup.slice(0, 2), ...atk.slice(0, 2)];
    for (const s of [...atk, ...setup]) if (pick.length < 4 && !pick.includes(s)) pick.push(s);
    return pick.slice(0, 4).map(s => s.name);
  }
  const swapIn = (plan, ci, from, to) => ({ af: plan.af && plan.af.map((r, i) => (i === ci ? r.map(x => (x === from ? to : x)) : r.slice())),
    turns: plan.turns.map(r => r.map((x, i) => (i === ci && x === from ? to : x))) });

  // party: 멤버(계산 멤버 + actions), opt: 전투 조건. conf = { passes: 2, equipSkills: false, tick(msg) } → { slots, plan, scores:{A,B,C}, perTurn, evals }
  function optimize(party, opt, conf = {}) {
    conf = { passes: 3, screen: 4, cond: !!opt.cond, ...conf };
    const memo = new Map();
    let team = party.map(m => ({ ...m, slots: m.slots && m.slots.length ? m.slots.slice(0, 4) : initialSlots(m, conf) }));
    const inner = { af: true, afCasts: 6, turns: 3, restarts: 0, passes: 2, memo };
    let cur = PL.plan(team, opt, inner), evals = cur.evals;
    // 칸 바꾸기 — ① 빠른 선별: 현재 계획에 그 스킬만 갈아 끼운 점수 1회(계획 다시 짜지 않음) ② 멤버마다 상위 conf.screen 개만 계획을 다듬어 채택
    //   (전부 다시 계획하면 실제 4인 25초 — 선별로 줄인다)
    const quick = (t2, plan) => { evals++; return S.run(t2, plan, opt, { scoreTurns: [2, 3, 4], memo }).score; };
    for (let pass = 0; pass < conf.passes; pass++) {
      let moved = false;
      for (let ci = 0; ci < team.length; ci++) {
        const cand = candidates(team[ci], conf).filter(n => !team[ci].slots.includes(n));
        const tries = [];
        for (let k = 0; k < 4; k++) for (const n of cand) {
          const from = team[ci].slots[k];
          const t2 = team.map((m, i) => (i === ci ? { ...m, slots: m.slots.map((x, j) => (j === k ? n : x)) } : m));
          const start = swapIn(cur.plan, ci, from, n);
          tries.push({ t2, start, q: quick(t2, start) });
        }
        tries.sort((a, b) => b.q - a.q);
        for (const t of tries.slice(0, conf.screen)) {
          const r = PL.plan(t.t2, opt, { ...inner, start: t.start });
          evals += r.evals;
          if (r.score > cur.score * (1 + 1e-9)) { cur = r; team = t.t2; moved = true; break; }
        }
        if (conf.tick) conf.tick(`${team[ci].c.nameKo}`);
      }
      if (!moved) break;
    }
    // 확정 — 재시작 8 로 계획을 다시, 보조 점수 B(1턴) · C(3턴)는 AF 없이 따로 계획
    const fin = PL.plan(team, opt, { af: true, afCasts: 6, turns: 3, restarts: 8, memo, start: cur.plan });
    const b = PL.plan(team, opt, { af: false, turns: 1, restarts: 4, memo });
    const c = PL.plan(team, opt, { af: false, turns: 3, restarts: 4, memo });
    return { slots: team.map(m => m.slots), plan: fin.plan, perTurn: fin.res.perTurn, log: fin.res.log,
      scores: { A: fin.score, B: b.score, C: c.score }, plans: { B: b.plan, C: c.plan }, evals: evals + fin.evals + b.evals + c.evals };
  }

  const api = { optimize, candidates, initialSlots, useful };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AEBuild = api;
})(typeof window !== "undefined" ? window : globalThis);
