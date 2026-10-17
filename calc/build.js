// 파티 빌드 최적화 (2026-10-17, plan ae-party-build O1) — 캐릭터 조합 고정 → 스킬칸 4개 · AF 계획 · 점수 3종
//   주 점수 A = AF(캐릭터당 6회) 뒤 비AF 3턴(T2~T4) 대미지 합 / 보조 B = AF 없이 1턴 / C = AF 없이 3턴 — 사용자 선택(10-17)
//   스킬칸: 멤버마다 칸 하나를 후보로 바꿔 보는 좌표 하강. 바꿀 때는 현재 계획에서 그 스킬만 갈아 끼운 계획으로 시작해 짧게 다듬는다(planner start)
//   장비(conf.gear = { poolsOf(member) → 후보, conf: partyGear conf }): 계획의 첫 점수 턴(T2)이 끝난 시점의 살아 있는 효과를 멤버 fx 로,
//     그 턴에 쓰는 공격을 attack 으로 넣어 AEOpt.partyGear(정적 식 · 공동 장비 · P글래스터 공유) → 새 장비로 계획을 다시 → conf.gearRounds 번
//   기회비용(contrib): 칸마다 그 장비를 뺐을 때 A 점수가 얼마 주는지 — 자기 대미지분 / 파티원 대미지분(계획 고정, 시나리오 1회씩)
//   그라스타 부여 스킬(D2, 10-17): grasta.json grant 의 존 전개 · 무기별 기도 · 공격을 스킬칸 후보로(스킬칸을 차지한다고 가정 — 딩님 DB 도 「장비 습득 스킬」을 스킬칸에 둔다).
//     후보 그라스타 = conf.grantsOf(멤버)(장비 최적화면 장착 가능한 전체, 아니면 지금 낀 것). 스킬을 칸에 넣으면 그 그라스타를 앞 칸에 끼우고 장비 단계에서 고정(lockGrasta)
//     순서: 스킬칸(지금 낀 그라스타의 부여 스킬만) → 장비 → 스킬칸(부여 스킬 전부, 찬 그라스타 칸을 밀어내는 비용을 치름) → 장비 → 나빠졌으면 앞 결과.
//     장비 전에 부여 스킬을 열면 빈 그라스타 칸에 능력치가 공짜로 붙어 그 그라스타가 고정됐다(실제 4인 A 32.1억 → 25.3억, 10-17)
//   부여 무기: 정적 장비 식은 「공격 시 적 저항 다운 · 페인/독」을 모른다 → 장비 단계 뒤 그런 무기만 시나리오 점수로 다시 비교
//   브라우저(window.AEBuild) · node 공용. 테스트: _tools/character/tests/test_build.cjs
(function (root) {
  "use strict";
  const S = root.AEScenario || require("./scenario.js");
  const PL = root.AEPlanner || require("./planner.js");
  const ENGINE = new Set(["stat_pct", "dmg", "buff", "ailment", "stack", "zone"]);
  const useful = sk => (sk.attacks || []).length > 0 || (sk.fx || []).some(u => ENGINE.has(u.k) && (!u.timing || u.timing === "use"));
  // 스킬칸 후보 — 쓸모 있는 스킬칸 스킬. 장비 습득 스킬은 conf.equipSkills, 자원 소비(구슬 · 카운트 · 게이지, s.needs)는 conf.cond 일 때만
  //   — 그 자원을 모으는 흐름은 시나리오가 아직 모른다(해방 영랑지처럼 아무 때나 쓰면 4.9배 과대, 10-17)
  // 구슬을 모으는 캐릭터(전투 시작 어빌리티 · 스킬 「구슬 축적」)는 구슬 소비 스킬도 후보 — 시나리오가 수치를 세고 모자라면 못 쓴다(D3 뼈대 10-18)
  const gathers = m => (m.actions.skills || []).some(s => (s.fx || []).some(u => u.k === "other" && u.name === "구슬 축적" && !u.cond));
  function candidates(m, conf = {}) {
    return (m.actions.skills || []).filter(s => s.slot && useful(s) && (!s.needEquip || conf.equipSkills) && (!s.needs || conf.cond || (s.needs.every(n => n === "구슬") && gathers(m)))
      && (!s.viaG || conf.via || (m.grasta || []).includes(s.viaG))).map(s => s.name);
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
  // 그라스타 부여 스킬 → 행동 단위 스킬(viaG = 그 그라스타). 디버프 · 기타(대미지에 안 닿음)는 뺀다
  const W_KO = { Ax: "도끼", Bow: "활", Fist: "권갑", Hammer: "망치", Katana: "도", Lance: "창", Staff: "지팡이", Sword: "검" };
  function grantSkill(g) {
    const r = g && g.grant;
    if (!r) return null;
    const sk = { name: r.skill, kind: "skill", slot: true, mp: r.mp || 0, attacks: [], fx: [], via: g.name, viaG: g };
    let w;
    if (r.kind === "zone" && r.zone) sk.fx.push({ k: "zone", name: r.zone });
    else if (r.kind === "attack" && r.attack) {
      const a = r.attack;
      sk.attacks.push({ power: a.mult, powerMax: a.multMax, hits: a.hits || 1, element: a.element || "", atk: a.atk || "", scope: a.scope || "", conds: a.conds });
    } else if (r.kind === "buff" && (w = /^(\w+) equipped characters' damage \+(\d+)% \((\d+) turns?\)/.exec(r.text || "")) && W_KO[w[1]])
      sk.fx.push({ k: "dmg", what: `${W_KO[w[1]]} 장착자 대미지`, dir: "UP", value: +w[2], tc: "아군 전체", turns: +w[3] });
    else return null;
    return sk;
  }
  // 멤버 행동에 부여 스킬을 덧붙인다(같은 이름 스킬이 이미 있으면 그대로)
  function withGrants(m, conf) {
    const gs = conf.grantsOf ? conf.grantsOf(m) : (m.grasta || []).filter(g => g && g.grant);
    const have = new Set((m.actions.skills || []).map(s => s.name)), extra = [];
    for (const g of gs || []) { const sk = !g.ore && grantSkill(g); if (sk && !have.has(sk.name)) { have.add(sk.name); extra.push(sk); } }
    return extra.length ? { ...m, actions: { ...m.actions, skills: [...m.actions.skills, ...extra] } } : m;
  }
  // 칸에 든 부여 스킬의 그라스타를 앞 칸에 — 일반 칸이 차면 뒤 칸부터 밀어낸다. lockGrasta = 장비 단계 고정
  function fitGrasta(m, slots) {
    const need = [...new Set(slots.map(n => ((m.actions.skills || []).find(s => s.name === n) || {}).viaG).filter(Boolean))];
    if (!need.length && !(m.lockGrasta || []).length) return m;
    const spec = m.special || [], normal = (m.grasta || []).filter(g => !spec.includes(g));
    const keep = normal.filter(g => !need.some(x => x.name === g.name));          // 전에 고정했던 것도 자리가 있으면 그대로 둔다
    return { ...m, grasta: [...need, ...keep].slice(0, Math.max(normal.length, need.length, m.gslots || 0)).concat(spec), lockGrasta: need };
  }
  const hasInflict = w => [...(w.fx || []), ...(w.calc || [])].some(f => f.k === "inflict");
  const swapIn = (plan, ci, from, to) => ({ af: plan.af && plan.af.map((r, i) => (i === ci ? r.map(x => (x === from ? to : x)) : r.slice())),
    turns: plan.turns.map(r => r.map((x, i) => (i === ci && x === from ? to : x))) });

  // party: 멤버(계산 멤버 + actions), opt: 전투 조건. conf = { passes: 2, equipSkills: false, tick(msg) } → { slots, plan, scores:{A,B,C}, perTurn, evals }
  function optimize(party, opt, conf = {}) {
    conf = { passes: 3, screen: 4, cond: !!opt.cond, ...conf };
    const memo = new Map();
    const gslots = (conf.gear && conf.gear.conf && conf.gear.conf.grastaSlots) || 4;
    let team = party.map(m => {
      const x = withGrants({ ...m, gslots }, conf), sl = x.slots && x.slots.length ? x.slots.slice(0, 4) : initialSlots(x, conf);
      return { ...fitGrasta(x, sl), slots: sl };
    });
    const inner = { af: true, afCasts: 6, turns: 3, restarts: 0, passes: 2, memo };
    let cur = PL.plan(team, opt, inner), evals = cur.evals;
    // 칸 바꾸기 — ① 빠른 선별: 현재 계획에 그 스킬만 갈아 끼운 점수 1회(계획 다시 짜지 않음) ② 멤버마다 상위 conf.screen 개만 계획을 다듬어 채택
    //   (전부 다시 계획하면 실제 4인 25초 — 선별로 줄인다)
    const quick = (t2, plan) => { evals++; return S.run(t2, plan, opt, { scoreTurns: [2, 3, 4], memo }).score; };
    const slotPass = cf => {
      for (let pass = 0; pass < cf.passes; pass++) {
        let moved = false;
        for (let ci = 0; ci < team.length; ci++) {
          const cand = candidates(team[ci], cf).filter(n => !team[ci].slots.includes(n));
          const tries = [];
          for (let k = 0; k < 4; k++) for (const n of cand) {
            const from = team[ci].slots[k];
            const t2 = team.map((m, i) => { if (i !== ci) return m; const sl = m.slots.map((x, j) => (j === k ? n : x)); return { ...fitGrasta(m, sl), slots: sl }; });
            const start = swapIn(cur.plan, ci, from, n);
            tries.push({ t2, start, q: quick(t2, start) });
          }
          tries.sort((a, b) => b.q - a.q);
          for (const t of tries.slice(0, cf.screen)) {
            const r = PL.plan(t.t2, opt, { ...inner, start: t.start });
            evals += r.evals;
            if (r.score > cur.score * (1 + 1e-9)) { cur = r; team = t.t2; moved = true; break; }
          }
          if (conf.tick) conf.tick(`${team[ci].c.nameKo}`);
        }
        if (!moved) break;
      }
    };
    // 장비 — 계획의 T2 효과 스냅숏으로 partyGear(고정 그라스타는 그대로), 새 장비로 다시 계획
    const gearHist = [];
    const O = conf.gear && (root.AEOpt || require("./optimizer.js"));
    const gearPass = rounds => {
      for (let round = 0; round < rounds; round++) {
        const snap = S.run(team, { af: cur.plan.af, turns: [cur.plan.turns[0]] }, opt, { memo: new Map() });
        const members = team.map((m, ci) => {
          let sk = (m.actions.skills || []).find(x => x.name === cur.plan.turns[0][ci]);
          let part = sk && (sk.attacks || []).find(a => !a.cond || opt.cond);
          // 그 턴에 공격이 없는 멤버(버퍼 · 아직 계획이 빈 칸)는 스킬칸 · 일반 공격 중 첫 공격을 대리로 — 자기 대미지 0 이면 방어구 · 배지가 전부 같은 점수라 빈 채로 남았다(시구레 ES 방어구 null, 10-18)
          if (!part) for (const n of [...m.slots, (S.normalOf(m) || {}).name]) {
            const s2 = (m.actions.skills || []).find(x => x.name === n), p2 = s2 && (s2.attacks || []).find(a => !a.cond || opt.cond);
            if (p2) { sk = s2; part = p2; break; }
          }
          return { ...m, fx: S.liveFx(snap.live, ci), attack: part ? S.toAttack(part, sk) : undefined, _contrib: null };
        });
        const punish = [...new Set([...(opt.punish || []), ...S.liveStates(snap.live)])];      // 파티가 건 페인 · 독(정적 식은 대상 상태를 모른다)
        const g = O.partyGear(members, { ...opt, zone: snap.zone || opt.zone, turns: 2, punish }, conf.gear.poolsOf, conf.gear.conf || {});
        evals += g.evals;
        team = team.map((m, i) => { const x = g.team[i]; return { ...m, weapon: x.weapon, armor: x.armor, badges: x.badges, grasta: x.grasta, special: (x.gear && x.gear.special) || [] }; });
        // 부여 무기 — 「공격 시 적 저항 다운 · 페인/독」 무기만 시나리오 점수로(계획 고정). 다른 멤버가 든 무기는 건너뜀
        let base = quick(team, cur.plan);
        team.forEach((m, ci) => {
          for (const w of (conf.gear.poolsOf(m).weapons || []).filter(hasInflict)) {
            if (w === m.weapon || team.some((o, j) => j !== ci && o.weapon && o.weapon.name === w.name)) continue;
            const t2 = team.map((x, j) => (j === ci ? { ...x, weapon: w } : x)), q = quick(t2, cur.plan);
            if (q > base * (1 + 1e-9)) { base = q; team = t2; }
          }
        });
        cur = PL.plan(team, opt, { ...inner, start: cur.plan, memo });
        evals += cur.evals;
        gearHist.push(cur.score);
        if (conf.tick) conf.tick(`장비 ${gearHist.length}회차`);
      }
    };
    slotPass(conf);
    if (conf.gear) {
      gearPass(conf.gearRounds ?? 1);                      // 2회차는 매번 같은 값이었다(실측 4인 3건) — 스킬칸 재탐색 뒤 한 번 더 돈다
      // 장비가 찬 뒤 스킬칸을 한 번 더(스킬 ↔ 장비 번갈아 — 실제 4인 +2.4%). 부여 스킬은 이때 연다: 그라스타 칸 기회비용을 치르게
      const keep = { team, cur };
      slotPass({ ...conf, via: !!conf.grantsOf, passes: 2 });
      if (team !== keep.team) gearPass(1);
      if (cur.score < keep.cur.score) ({ team, cur } = keep);
    } else if (conf.grantsOf) slotPass({ ...conf, via: true, passes: 2 });
    // 확정 — 재시작 8 로 계획을 다시, 보조 점수 B(1턴) · C(3턴)는 AF 없이 따로 계획
    const fin = PL.plan(team, opt, { af: true, afCasts: 6, turns: 3, restarts: 8, memo, start: cur.plan });
    const b = PL.plan(team, opt, { af: false, turns: 1, restarts: 4, memo });
    const c = PL.plan(team, opt, { af: false, turns: 3, restarts: 4, memo });
    return { team, slots: team.map(m => m.slots), via: team.map(m => m.slots.map(n => ((m.actions.skills || []).find(s => s.name === n) || {}).via || null)), plan: fin.plan, perTurn: fin.res.perTurn, perMember: fin.res.perMember, log: fin.res.log, gearHist,
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

  const api = { optimize, candidates, initialSlots, useful, contributions, grantSkill, withGrants, fitGrasta };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AEBuild = api;
})(typeof window !== "undefined" ? window : globalThis);
