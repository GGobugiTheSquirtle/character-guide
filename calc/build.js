// 파티 빌드 최적화 (2026-10-17, plan ae-party-build O1) — 캐릭터 조합 고정 → 스킬칸 4개 · AF 계획 · 점수 3종
//   주 점수 A = AF(캐릭터당 6회) 뒤 비AF 3턴(T2~T4) 대미지 합 / 보조 B = AF 없이 1턴 / C = AF 없이 3턴 — 사용자 선택(10-17)
//   스킬칸: 멤버마다 칸 하나를 후보로 바꿔 보는 좌표 하강. 바꿀 때는 현재 계획에서 그 스킬만 갈아 끼운 계획으로 시작해 짧게 다듬는다(planner start)
//   장비(conf.gear = { poolsOf(member) → 후보, conf: partyGear conf }): 계획의 첫 점수 턴(T2)이 끝난 시점의 살아 있는 효과를 멤버 fx 로,
//     그 턴에 쓰는 공격을 attack 으로 넣어 AEOpt.partyGear(정적 식 · 공동 장비 · P글래스터 공유) → 새 장비로 계획을 다시 → conf.gearRounds 번
//   기회비용(contrib): 칸마다 그 장비를 뺐을 때 A 점수가 얼마 주는지 — 자기 대미지분 / 파티원 대미지분(계획 고정, 시나리오 1회씩)
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
    // 장비 — 계획의 T2 효과 스냅숏으로 partyGear, 새 장비로 다시 계획(장비가 바뀌면 메모는 새로)
    const gearHist = [];
    if (conf.gear) {
      const O = root.AEOpt || require("./optimizer.js");
      for (let round = 0; round < (conf.gearRounds ?? 2); round++) {
        const snap = S.run(team, { af: cur.plan.af, turns: [cur.plan.turns[0]] }, opt, { memo: new Map() });
        const members = team.map((m, ci) => {
          const sk = (m.actions.skills || []).find(x => x.name === cur.plan.turns[0][ci]);
          const part = sk && (sk.attacks || []).find(a => !a.cond || opt.cond);
          return { ...m, fx: S.liveFx(snap.live, ci), attack: part ? S.toAttack(part, sk) : undefined, _contrib: null };
        });
        const g = O.partyGear(members, { ...opt, zone: snap.zone || opt.zone, turns: 2 }, conf.gear.poolsOf, conf.gear.conf || {});
        evals += g.evals;
        team = team.map((m, i) => { const x = g.team[i]; return { ...m, weapon: x.weapon, armor: x.armor, badges: x.badges, grasta: x.grasta, special: (x.gear && x.gear.special) || [] }; });
        memo.clear();
        cur = PL.plan(team, opt, { ...inner, start: cur.plan, memo });
        evals += cur.evals;
        gearHist.push(cur.score);
        if (conf.tick) conf.tick(`장비 ${round + 1}회차`);
      }
    }
    // 확정 — 재시작 8 로 계획을 다시, 보조 점수 B(1턴) · C(3턴)는 AF 없이 따로 계획
    const fin = PL.plan(team, opt, { af: true, afCasts: 6, turns: 3, restarts: 8, memo, start: cur.plan });
    const b = PL.plan(team, opt, { af: false, turns: 1, restarts: 4, memo });
    const c = PL.plan(team, opt, { af: false, turns: 3, restarts: 4, memo });
    return { team, slots: team.map(m => m.slots), plan: fin.plan, perTurn: fin.res.perTurn, perMember: fin.res.perMember, log: fin.res.log, gearHist,
      scores: { A: fin.score, B: b.score, C: c.score }, plans: { B: b.plan, C: c.plan }, evals: evals + fin.evals + b.evals + c.evals,
      contrib: contributions(team, fin.plan, opt) };
  }

  // 기회비용 — 칸(무기 · 방어구 · 그라스타 · 배지 · 스킬)마다 「빼면 A 점수가 얼마 주나」를 자기 몫 / 파티원 몫으로. 계획은 고정(스킬은 그 칸을 안 씀으로)
  function contributions(team, plan, opt) {
    const sc = { scoreTurns: [2, 3, 4] };
    const base = S.run(team, plan, opt, sc);
    const out = team.map(() => []);
    const diff = (ci, t2, p2, kind, name) => {
      const r = S.run(t2, p2 || plan, opt, sc);
      const own = base.perMember[ci] - r.perMember[ci], all = base.score - r.score;
      out[ci].push({ kind, name, total: all, own, party: all - own, pct: base.score ? all / base.score : 0 });
    };
    team.forEach((m, ci) => {
      const put = patch => team.map((x, i) => (i === ci ? { ...x, ...patch, _contrib: null } : x));
      if (m.weapon) diff(ci, put({ weapon: { ...m.weapon, atk: 0, matk: 0, calc: [], fx: [], stats: {} } }), null, "무기", m.weapon.name);
      if (m.armor) diff(ci, put({ armor: null }), null, "방어구", m.armor.name);
      (m.grasta || []).forEach((g, i) => diff(ci, put({ grasta: m.grasta.filter((_, j) => j !== i) }), null, "그라스타", g.name));
      (m.badges || []).forEach((b, i) => diff(ci, put({ badges: m.badges.filter((_, j) => j !== i) }), null, "배지", b.name));
      (m.slots || []).forEach(n => diff(ci, team, { af: plan.af && plan.af.map((r, i) => (i === ci ? r.map(x => (x === n ? null : x)) : r)),
        turns: plan.turns.map(r => r.map((x, i) => (i === ci && x === n ? null : x))) }, "스킬", n));
      out[ci].sort((a, b) => b.total - a.total);
    });
    return { base: base.score, perMember: base.perMember, items: out };
  }

  const api = { optimize, candidates, initialSlots, useful, contributions };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AEBuild = api;
})(typeof window !== "undefined" ? window : globalThis);
