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
  const AP = root.AEParty || require("./party_calc.js");
  const ENGINE = new Set(["stat_pct", "dmg", "buff", "ailment", "stack", "zone"]);
  const useful = sk => (sk.attacks || []).length > 0 || (sk.fx || []).some(u => ENGINE.has(u.k) && (!u.timing || u.timing === "use"));
  // 스킬칸 후보 — 쓸모 있는 스킬칸 스킬. 장비 습득 스킬은 conf.equipSkills, 자원 소비(구슬 · 카운트 · 게이지, s.needs)는 conf.cond 일 때만
  //   — 그 자원을 모으는 흐름은 시나리오가 아직 모른다(해방 영랑지처럼 아무 때나 쓰면 4.9배 과대, 10-17)
  // 구슬을 모으는 캐릭터(전투 시작 어빌리티 · 스킬 「구슬 축적」)는 구슬 소비 스킬도 후보 — 시나리오가 수치를 세고 모자라면 못 쓴다(D3 뼈대 10-18)
  const gathers = m => (m.actions.skills || []).some(s => (s.fx || []).some(u => u.k === "other" && u.name === "구슬 축적" && !u.cond));
  function candidates(m, conf = {}) {
    return (m.actions.skills || []).filter(s => s.slot && !/\bEOT\b/.test(s.name) && useful(s) && (!s.needEquip || conf.equipSkills) && (!s.needs || conf.cond || (s.needs.every(n => n === "구슬") && gathers(m)))
      && (!s.viaG || conf.via || (m.grasta || []).includes(s.viaG))).map(s => s.name);
  }
  // 시작 스킬칸 — 준비 스킬(엔진 효과 수 많은 순) 2 + 공격(1회 위력 × 타수 큰 순) 2, 모자라면 나머지로
  function initialSlots(m, conf) {
    const cand = candidates(m, conf).map(n => m.actions.skills.find(s => s.name === n));
    const power = s => Math.max(0, ...(s.attacks || []).map(a => (a.power ?? a.mult ?? 0) * (a.hits || 1)));
    const setup = cand.filter(s => !(s.attacks || []).length).sort((a, b) => b.fx.filter(u => ENGINE.has(u.k)).length - a.fx.filter(u => ENGINE.has(u.k)).length);
    const atk = cand.filter(s => (s.attacks || []).length).sort((a, b) => power(b) - power(a));
    const ns = conf && conf.setupFirst ? 4 : 2;                                   // setupFirst = 지원 위주(준비 스킬부터 4칸) — 파티원 추천의 거르기용
    const pick = [...setup.slice(0, ns), ...atk.slice(0, 4 - ns)];
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
    // 특수 광석을 넣은 그라스타도 본래 부여 스킬은 그대로(11-08 — hinaden 「진의 주문 <지열진> + 지열진 광석」의 지열진 전개가 빠져 다른 존으로 계산됐다).
    //   후보 풀의 광석 판 중복은 호출 쪽 grantsOf 가 거른다(compare_rec · 화면 = !g.ore)
    for (const g of gs || []) { const sk = grantSkill(g); if (sk && !have.has(sk.name)) { have.add(sk.name); extra.push(sk); } }
    return extra.length ? { ...m, actions: { ...m.actions, skills: [...m.actions.skills, ...extra] } } : m;
  }
  // 고정 스킬칸(m.lock = 이용자가 이름으로 지정한 스킬, 2026-11-11) — 앞칸에 두고 나머지만 시작 스킬칸으로 채운다. 탐색(slotPass)은 고정 칸을 건드리지 않는다
  function startSlots(x, conf) {
    if (!(x.lock && x.lock.length)) return x.slots && x.slots.length ? x.slots.slice(0, 4) : initialSlots(x, conf);
    const has = new Set((x.actions.skills || []).filter(s => s.slot).map(s => s.name));
    const sl = [...new Set(x.lock)].filter(n => has.has(n)).slice(0, 4);
    for (const n of [...(x.slots || []), ...initialSlots(x, conf)]) if (sl.length < 4 && has.has(n) && !sl.includes(n)) sl.push(n);
    return sl;
  }
  const freeSlots = m => [0, 1, 2, 3].filter(k => !(m.lock || []).includes(m.slots[k]));
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
    conf = { passes: 3, screen: 4, cond: !!opt.cond, carryStarts: true, pairMoves: true, punishStart: true, ...conf };
    let memo = new Map();
    const gslots = (conf.gear && conf.gear.conf && conf.gear.conf.grastaSlots) || 4;
    let team = party.map(m => {
      const x = withGrants({ ...m, gslots }, conf), sl = startSlots(x, conf);
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
          if (cf.only && !cf.only.includes(ci)) continue;                          // 그 멤버만 칸을 고른다(파티원 추천의 다듬기)
          const cand = candidates(team[ci], cf).filter(n => !team[ci].slots.includes(n));
          const tries = [];
          const put = ch => {                                   // ch = [[칸, 새 스킬], …]
            const t2 = team.map((m, i) => { if (i !== ci) return m; const sl = m.slots.slice(); for (const [k, n] of ch) sl[k] = n; return { ...fitGrasta(m, sl), slots: sl }; });
            const start = ch.reduce((p, [k, n]) => swapIn(p, ci, team[ci].slots[k], n), cur.plan);
            tries.push({ t2, start, q: quick(t2, start) });
          };
          const fk = freeSlots(team[ci]);
          for (const k of fk) for (const n of cand) put([[k, n]]);
          // 두 칸 동시(cf.pair) — 한 칸씩은 손해라 못 넘는 조합(아래 pairMoves)
          if (cf.pair) for (const k1 of fk) for (const k2 of fk) if (k1 < k2) for (const n1 of cand) for (const n2 of cand) if (n1 !== n2) put([[k1, n1], [k2, n2]]);
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
    const gearPass = (rounds, carry) => {
      const gconf = carry ? { ...(conf.gear.conf || {}), objective: "carry", carry } : conf.gear.conf || {};
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
        const g = O.partyGear(members, { ...opt, zone: snap.zone || opt.zone, turns: 2, punish }, conf.gear.poolsOf, gconf);
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
    const starts = [];
    if (conf.gear) {
      // 주력 다중 시작(conf.carryStarts, 기본 켬, 11-04) — 첫 장비 배분이 개수 제한 장비(Pain · Agony 그라스타 등)를 누구에게 줄지 정하고, 뒤 단계는 그 주력에 묶인다
      //   (실제 4인: 기본 59.7억에 멈춤, 밀디 주력 빌드 80.5억). 기본 갈래 + 멤버마다 「그 멤버 주력 가중」 첫 배분 갈래 → 갈래마다 같은 뒷단계 → 최댓값
      //   대표 3파티 이득 +4.6% · +52% · +0.01%, 시간 약 2배(첫 스킬칸 탐색 · 메모 공유) — docs/ae-damage-pipeline.md §9
      const fork = { team, cur, hist: gearHist.length };
      const seeds = [null, ...(conf.carryStarts ? team.map(m => m.c.id) : []), ...(conf.punishStart ? ["punish"] : [])];
      let top = null;
      for (const seed of seeds) {
        ({ team, cur } = fork); gearHist.length = fork.hist;
        if (seed === "punish") {
          // 대상 상태 가정 갈래(conf.punishStart, 11-05) — 받는 쪽(「Rust ○○」 페인 ×2 · 독 ×2, 「페인 대상 +30%」 그라스타)과 거는 쪽(무기 「공격 시 페인/독」, 멤버 여럿)은
          //   하나씩 바꾸면 서로 없이 손해라 같이 못 들어온다(국화의 검객 파티: 옛 빌드 2.68억 · 탐색 1.96억). 대상이 페인 · 독이라고 가정하고 받는 쪽을 먼저 채운 뒤,
          //   실제 조건으로 돌아와 장비 단계의 「부여 무기」 비교가 거는 무기를 하나씩 채택하게 한다. 가정 단계는 메모를 따로(메모 키에 punish 가 없다)
          //   5파티: 1.96 → 3.08억(+57%, Scar Slicer 페인 + Rust Earth Edge) · 레비아 파티 +7.8% · 나머지 0, 평가 +20~28% → 기본 켬
          const real = opt, realMemo = memo;
          opt = { ...real, punish: [...new Set([...(real.punish || []), "pain", "poison"])] }; memo = new Map(); inner.memo = memo;
          cur = PL.plan(team, opt, { ...inner, start: cur.plan }); evals += cur.evals;
          gearPass(1);
          slotPass({ ...conf, via: !!conf.grantsOf, passes: 2 });
          gearPass(1);
          opt = real; memo = realMemo; inner.memo = memo;
          cur = PL.plan(team, opt, { ...inner, start: cur.plan }); evals += cur.evals;
        }
        gearPass(conf.gearRounds ?? 1, seed === "punish" ? null : seed);   // 2회차는 매번 같은 값이었다(실측 4인 3건) — 스킬칸 재탐색 뒤 한 번 더 돈다
        if (seed && seed !== "punish") gearPass(1);        // 주력 가중을 풀고 파티 전체 기준으로 다듬는다
        // 장비가 찬 뒤 스킬칸을 한 번 더(스킬 ↔ 장비 번갈아 — 실제 4인 +2.4%). 부여 스킬은 이때 연다: 그라스타 칸 기회비용을 치르게
        const keep = { team, cur };
        slotPass({ ...conf, via: !!conf.grantsOf, passes: 2 });
        if (team !== keep.team) gearPass(1);
        if (cur.score < keep.cur.score) ({ team, cur } = keep);
        starts.push({ carry: seed, score: cur.score });
        if (conf.tick) conf.tick(`시작 ${seed || "기본"}: A ${(cur.score / 1e8).toFixed(2)}억`);
        if (!top || cur.score > top.cur.score * (1 + 1e-9)) top = { team, cur, hist: gearHist.slice() };
      }
      ({ team, cur } = top); gearHist.splice(0, gearHist.length, ...top.hist);
      // 두 칸 동시 이동(conf.pairMoves, 기본 켬, 11-04) — 최고 갈래에서 멤버마다 스킬칸 두 칸을 함께 바꿔 본다 → 바뀌면 장비 한 번 더.
      //   거는 쪽 + 받는 쪽(독을 거는 스킬 + 「독 대상 ×2」 Rust 스킬)처럼 하나만 넣으면 손해인 짝을 넘는다. 대표 3파티 +6.3% · 0 · +94%, 평가 +7% · +0.5% · +18%
      if (conf.pairMoves) {
        const keep = { team, cur };
        slotPass({ ...conf, via: !!conf.grantsOf, passes: 2, pair: true });
        if (team !== keep.team) gearPass(1);
        if (cur.score < keep.cur.score) ({ team, cur } = keep);
        if (conf.tick) conf.tick(`두 칸 동시: A ${(keep.cur.score / 1e8).toFixed(2)} → ${(cur.score / 1e8).toFixed(2)}억`);
      }
    } else if (conf.grantsOf) slotPass({ ...conf, via: true, passes: 2 });
    // 후열 셔틀(10-18) — conf.back = [{c, cc, pool?}] 은 공격 · 효과 없이 공유 그라스타만 나른다. 칸마다 후보를 바꿔 A 점수(계획 고정)가 오르면 채택 → 다시 계획.
    //   후보 = pool(없으면 장비 후보 중 공유 그라스타). 획득 가능 수(limit)는 전방이 낀 것까지 세고, 같은 그라스타를 둘이 나르면 둘 다 들어간다(공유분 중첩, 10-15 사용자 확인)
    const back = (conf.back || []).map(b => ({ c: b.c, cc: b.cc, pool: b.pool || (conf.gear ? (conf.gear.poolsOf(b).grasta || []).filter(g => g.share && !g.ore) : []), grasta: Array(gslots).fill(null) }));
    if (back.length) {
      const setBack = () => { opt = { ...opt, back: back.map(b => ({ c: b.c, cc: b.cc, grasta: b.grasta.filter(Boolean) })) }; };
      const used = g => [...team.flatMap(m => m.grasta || []), ...back.flatMap(b => b.grasta)].filter(x => x && (x.base || x.name) === (g.base || g.name)).length;
      setBack();
      let best = quick(team, cur.plan);
      for (let pass = 0; pass < 3; pass++) {
        let moved = false;
        for (const b of back) for (let k = 0; k < gslots; k++) for (const g of [null, ...b.pool]) {
          const was = b.grasta[k];
          if (g === was || (g && used(g) >= (g.limit ?? Infinity))) continue;
          b.grasta[k] = g; setBack();
          const q = quick(team, cur.plan);
          if (q > best * (1 + 1e-9)) { best = q; moved = true; } else { b.grasta[k] = was; setBack(); }
        }
        if (!moved) break;
      }
      cur = PL.plan(team, opt, { ...inner, start: cur.plan, memo });
      evals += cur.evals;
    }
    // 확정 — 재시작 8 로 계획을 다시, 보조 점수 B(1턴) · C(3턴)는 AF 없이 따로 계획
    const fin = PL.plan(team, opt, { af: true, afCasts: 6, turns: 3, restarts: 8, memo, start: cur.plan });
    const b = PL.plan(team, opt, { af: false, turns: 1, restarts: 4, memo });
    const c = PL.plan(team, opt, { af: false, turns: 3, restarts: 4, memo });
    return { team, slots: team.map(m => m.slots), via: team.map(m => m.slots.map(n => ((m.actions.skills || []).find(s => s.name === n) || {}).via || null)), plan: fin.plan, perTurn: fin.res.perTurn, perMember: fin.res.perMember, log: fin.res.log, gearHist, starts,
      scores: { A: fin.score, B: b.score, C: c.score }, plans: { B: b.plan, C: c.plan }, evals: evals + fin.evals + b.evals + c.evals,
      contrib: contributions(team, fin.plan, opt), back: opt.back || [] };
  }

  // 고점 빌드(2026-11-05, 사용자 「4개 다 활용 · 고점 기준 · 단순하게」) — 점수 = scenario.peak(반복 고점: 스킬칸 4개 효과 전부 최대 누적 + 가장 센 공격 1회, 1회성 끔).
  //   행동 계획 · 턴 · 지속 · 자원을 안 본다. 스킬칸 = 한 칸 · 두 칸 좌표 하강, 장비 = 고점 장면의 효과 · 공격을 넣은 partyGear(주력 가중 시작 갈래 포함). 순간 최고점(1회성 포함)은 함께 보고
  //   conf = { gear, grantsOf, tick, carryStarts(기본 켬) } → { team, slots, scores: { repeat, burst }, perMember, attackOf, zone, evals }
  //   계산식 묶음별 빌드(11-11, 사용자 「가장 센 공격은 애매 — 계산식별로」): conf.pin = { 멤버 번호: [스킬 이름…] } 그 멤버의 공격을 그 스킬들로 고정,
  //     conf.focus = 멤버 번호 → 목표 = 그 멤버 몫(나머지는 1e-6 동률 깨기) · 장비는 항상 그 멤버 주력 가중. conf.pairMoves: false = 두 칸 동시 이동 생략
  function optimizePeak(party, opt, conf = {}) {
    conf = { passes: 3, cond: true, carryStarts: true, pairMoves: true, ...conf };   // 후보에 자원 소비 스킬도 — 고점 = 자원이 찬 상태
    party = muteTeam(party, conf.mute);
    const focus = conf.focus != null ? conf.focus : null, fid = focus != null ? party[focus].c.id : null;
    const scoreOf = r => focus == null ? r.score : r.perMember[focus] + 1e-6 * (r.score - r.perMember[focus]);
    const gslots = (conf.gear && conf.gear.conf && conf.gear.conf.grastaSlots) || 4;
    let evals = 0;
    const peakOf = (t, mode) => { evals++; return S.peak(t, opt, { mode, pin: conf.pin }); };   // 메모 없음 — 장면이 평가마다 달라 거의 안 맞고 키만 쌓였다(8분 뒤 메모리 부족)
    let team = party.map(m => {
      const x = withGrants({ ...m, gslots }, conf), sl = startSlots(x, conf);
      return { ...fitGrasta(x, sl), slots: sl };
    });
    let cur = scoreOf(peakOf(team));
    const slotPass = cf => {
      for (let pass = 0; pass < cf.passes; pass++) {
        let moved = false;
        for (let ci = 0; ci < team.length; ci++) {
          if (cf.only && !cf.only.includes(ci)) continue;                          // 그 멤버만 칸을 고른다(파티원 추천의 다듬기)
          const cand = candidates(team[ci], cf).filter(n => !team[ci].slots.includes(n));
          const moves = [];
          const fk = freeSlots(team[ci]);
          for (const k of fk) for (const n of cand) moves.push([[k, n]]);
          if (cf.pair) for (const k1 of fk) for (const k2 of fk) if (k1 < k2) for (const n1 of cand) for (const n2 of cand) if (n1 !== n2) moves.push([[k1, n1], [k2, n2]]);
          let best = null;
          for (const ch of moves) {
            const t2 = team.map((m, i) => { if (i !== ci) return m; const sl = m.slots.slice(); for (const [k, n] of ch) sl[k] = n; return { ...fitGrasta(m, sl), slots: sl }; });
            const q = scoreOf(peakOf(t2));
            if (q > (best ? best.q : cur) * (1 + 1e-9)) best = { t2, q };
          }
          if (best) { team = best.t2; cur = best.q; moved = true; }
          if (conf.tick) conf.tick(`${team[ci].c.nameKo}`);
        }
        if (!moved) break;
      }
    };
    const O = conf.gear && (root.AEOpt || require("./optimizer.js"));
    const gearPass = seed => {
      const carry = seed || fid, pk = peakOf(team);
      const members = team.map((m, ci) => {
        const sk = (m.actions.skills || []).find(x => x.name === pk.attackOf[ci]), part = sk && (sk.attacks || [])[0];
        return { ...m, fx: S.liveFx(pk.live, ci), attack: part ? S.toAttack(part, sk) : undefined, _contrib: null };
      });
      const gopt = { ...opt, cond: true, peak: "repeat", lunatic: true, breakOn: true, maxHp: true, zone: pk.zone || opt.zone, punish: [...new Set([...(opt.punish || []), ...S.liveStates(pk.live)])] };
      // 멤버 비중 = 고점 몫 ÷ 정적 값(11-08, optimizer.partyGear conf.scale) — 고점 몫이 0 인 멤버(버프만)는 자기 대미지 비중 0
      const pre = AP.prepare(members, gopt), scale = {};
      members.forEach((m, i) => { const st = (AP.memberDamage(m, members, gopt, pre) || {}).perUse || 0; scale[m.c.id] = st > 0 ? pk.perMember[i] / st : 1; });
      const gconf = { ...(conf.gear.conf || {}), ...(carry ? { objective: "carry", carry } : {}), scale };
      const g = O.partyGear(members, gopt, conf.gear.poolsOf, gconf);
      evals += g.evals;
      const prev = { team, cur };
      team = team.map((m, i) => { const x = g.team[i]; return { ...m, weapon: x.weapon, armor: x.armor, badges: x.badges, grasta: x.grasta, special: (x.gear && x.gear.special) || [] }; });
      cur = scoreOf(peakOf(team));
      if (!seed && cur < prev.cur * (1 - 1e-9)) ({ team, cur } = prev);   // 정적 식은 근사 — 고점이 내려가면 받지 않는다(주력 가중 갈래는 다음 갈래로 이어지니 그대로)
    };
    // 대상 상태(독 · 페인)를 거는 스킬은 그 상태 조건 장비와 함께 들어가야 이득이 보인다 — 한 칸 넣기는 장비가 없어 이득 0, 장비 단계는 상태가 없어 안 고른다.
    //   11-11 M9: 히나 4칸 무작위 고정(독 스킬 포함)이 자유 탐색을 +45.5% 이겼다(장비가 노아키스 AS · 우트팔라카에게 독 조건 그라스타). 그래서 묶음으로 시도한다
    const statesOf = s => S.liveStates(new Map((s.fx || []).map((u, i) => [i, { u }])));
    const stateMoves = () => {
      const cf = { ...conf, via: !!conf.grantsOf };
      for (let ci = 0; ci < team.length; ci++) {
        const live = new Set(S.liveStates(peakOf(team).live));
        const sks = candidates(team[ci], cf).filter(n => !team[ci].slots.includes(n)).map(n => team[ci].actions.skills.find(s => s.name === n))
          .filter(s => statesOf(s).some(st => !live.has(st)));
        for (const sk of sks) {
          const keep = { team, cur };
          let best = null;
          for (const k of freeSlots(team[ci])) {                                  // 그 스킬이 들어갈 칸 = 장비 그대로 잃는 몫이 가장 적은 칸
            const t2 = team.map((m, i) => { if (i !== ci) return m; const sl = m.slots.slice(); sl[k] = sk.name; return { ...fitGrasta(m, sl), slots: sl }; });
            const q = scoreOf(peakOf(t2));
            if (!best || q > best.q) best = { t2, q };
          }
          if (!best) continue;
          ({ t2: team, q: cur } = best);
          gearPass(null);
          slotPass({ ...cf, passes: 1 });
          gearPass(null);
          if (conf.tick) conf.tick(`상태 묶음 ${team[ci].c.nameKo} ${sk.name}: ${(cur / 1e8).toFixed(2)}억`);
          if (!(cur > keep.cur * (1 + 1e-9))) ({ team, cur } = keep);
        }
      }
    };
    slotPass(conf);
    if (conf.gear) {
      const branches = () => {
        const fork = { team, cur };
        let top = null;
        for (const seed of [null, ...(conf.carryStarts ? team.map(m => m.c.id) : [])]) {
          ({ team, cur } = fork);
          gearPass(seed);
          if (seed) gearPass(null);
          slotPass({ ...conf, via: !!conf.grantsOf, passes: conf.branchPasses ?? 2 });   // branchPasses 0 = 스킬칸 그대로 장비만(파티원 추천의 그라스타 단계)
          gearPass(null);
          if (conf.tick) conf.tick(`시작 ${seed || "기본"}: 고점 ${(cur / 1e8).toFixed(2)}억`);
          if (!top || cur > top.cur * (1 + 1e-9)) top = { team, cur };
        }
        ({ team, cur } = top);
      };
      branches();
      const settled = team;
      if (conf.stateMoves !== false) stateMoves();
      // 두 칸 동시는 최고 갈래에서 한 번만(멤버당 후보² 이라 갈래마다 돌리면 수천 번)
      if (conf.pairMoves) {
        const keep = { team, cur };
        slotPass({ ...conf, via: !!conf.grantsOf, passes: 1, pair: true });
        if (team !== keep.team) gearPass(null);
        if (cur < keep.cur) ({ team, cur } = keep);
      }
      // 스킬칸이 바뀌었으면 장비 갈래를 새 칸에서 다시 — 갈래는 옛 칸에 맞춰 골랐다(11-11 M9: 두 칸 바꾸기 뒤 장비 한 번만 다시 → 같은 칸을 고정한 빌드가 +8.1%)
      if (team !== settled && conf.rebranch !== false) {
        const keep = { team, cur };
        branches();
        if (cur < keep.cur) ({ team, cur } = keep);
      }
    } else slotPass({ ...conf, via: !!conf.grantsOf, passes: 2, pair: true });
    const with_ = (t, o) => { evals++; return scoreOf(S.peak(t, o, { pin: conf.pin })); };
    if (conf.back && conf.back.length && conf.gear) opt = shuttle(conf.back, team, opt, conf, with_, gslots);
    const r = S.peak(team, opt, { pin: conf.pin, explain: true }), rb = peakOf(team, "burst");   // 마지막 한 번만 계산 근거를 모은다
    const sc = t => S.peak(t, opt, { pin: conf.pin }).score;
    const contrib = conf.contrib ? { ...gearContrib(team, sc), back: backContrib(team, opt, (t, o) => S.peak(t, o, { pin: conf.pin }).score) } : null;
    const fxc = conf.fxContrib ? fxContrib(team, sc) : null;
    return { team, slots: team.map(m => m.slots), explain: r.explain, contrib, fxContrib: fxc, back: opt.back || [], via: team.map(m => m.slots.map(n => ((m.actions.skills || []).find(s => s.name === n) || {}).via || null)),
      scores: { repeat: r.score, burst: rb.score }, perMember: r.perMember, perMemberBurst: rb.perMember, attackOf: r.attackOf, attackOfBurst: rb.attackOf, zone: r.zone, evals };
  }

  // 속도 중심 장비(11-12, 사용자 「목표 밖 멤버 — 공격 중심 / 속도 중심」) — 남은 장비에서 속도 합이 큰 것(같으면 힘 + 지능). 다른 멤버가 쓴 장비(무기 · 방어구 · 배지 · 그라스타 기본 이름)는 피한다.
  //   고정 칸(lockWeapon · lockArmor · lockGrasta · lockBadges)은 그대로. 정적 식으로 재지 않는다(속도는 순서 입력에선 대미지에 안 들어간다 — 이용자가 순서를 맞추는 데 쓴다)
  //   keep = 목표를 받치는 장비는 그대로 — 「공격 시 적 저항 다운 · 페인/독」 무기 · 공유 그라스타(남에게 가는 효과). 사용자 「목표 밖이라도 공격하면 루나로 내성 깎기가 되는 경우」
  function speedGear(m, team, pools, keep) {
    const spd = it => ((it && it.stats) || {}).spd || 0, sub = it => { const st = (it && it.stats) || {}; return (st.pwr || 0) + (st.int || 0) + (it && (it.atk || 0) + (it.matk || 0)) * 1e-3; };
    const by = (a, b) => spd(b) - spd(a) || sub(b) - sub(a);
    const others = team.filter(x => x.c.id !== m.c.id), usedE = new Set(others.flatMap(x => [x.weapon, x.armor].filter(Boolean).map(i => i.name)));
    const usedG = new Set(others.flatMap(x => (x.grasta || []).map(g => g.base || g.name))), usedB = new Set(others.flatMap(x => (x.badges || []).filter(b => b && b.kind !== "random").map(b => b.name)));
    const weapon = m.lockWeapon || (keep && m.weapon && hasInflict(m.weapon) ? m.weapon : null) || (pools.weapons || []).filter(w => !usedE.has(w.name)).sort(by)[0] || m.weapon;
    const armor = m.lockArmor || (pools.armor || []).filter(a => !usedE.has(a.name)).sort(by)[0] || m.armor;
    const lockG = [...(m.lockGrasta || []), ...(keep ? (m.grasta || []).filter(g => g && g.share && !(m.lockGrasta || []).includes(g) && !(m.special || []).includes(g)) : [])], gs = Math.max(m.gslots || 4, lockG.length), seenG = new Set(lockG.map(g => g.base || g.name)), grasta = [...lockG];
    for (const g of (pools.grasta || []).slice().sort(by)) { if (grasta.length >= gs) break; const b = g.base || g.name; if (usedG.has(b) || seenG.has(b)) continue; seenG.add(b); grasta.push(g); }
    const lockB = m.lockBadges || [], badges = [...lockB];
    for (const b of (pools.badges || []).slice().sort(by)) { if (badges.length >= 2) break; if (b.kind !== "random" && (usedB.has(b.name) || badges.includes(b))) continue; badges.push(b); }
    return { weapon, armor, grasta: [...grasta, ...(m.special || [])], badges };
  }

  // 순서 빌드(11-12, 사용자 「A-B-E-D-A-B-T-R — 2번째 B · R · A~D 구간 · 전체의 대미지 극대화」) — 행동 순서 seq = [[멤버 번호, 스킬], …] 를 고정하고 장비만 고른다.
  //   턴 나누기 · 턴 안 순서 = S.seqTurns(속도는 이용자가 맞춘다고 본다). 목표 = conf.steps(행동 번호, 없으면 전부)의 대미지 합. AF 는 넣지 않는다(AF 대미지는 따로 볼 것 — 사용자).
  //   스킬칸 = 순서에 나온 스킬칸 스킬(멤버당 4개 넘으면 오류). 장비 = 멤버마다 목표 행동 중 가장 센 것 직전 장면(snapAt)의 살아 있는 효과 + 그 공격으로
  //   AEOpt.partyGear(정적 식 · 근사 — 멤버 비중 = 순서 점수 몫 ÷ 정적 값, 순서 점수가 오를 때만 받는다) → 「공격 시」 부여 무기는 순서 점수로 → conf.gearRounds(기본 2).
  //   목표 행동을 가진 멤버가 둘 이상이면 그 멤버마다 주력 가중 시작 갈래도 돌려 가장 높은 것
  function optimizeSeq(party, seq, opt, conf = {}) {
    party = muteTeam(party, conf.mute);
    const gslots = (conf.gear && conf.gear.conf && conf.gear.conf.grastaSlots) || 4;
    const steps = conf.steps && conf.steps.length ? conf.steps.filter(k => seq[k]) : seq.map((_, k) => k);
    let evals = 0;
    // 그라스타 부여 스킬(11-12) — 순서에 쓴 것의 그라스타 = m.extraGrants(화면이 넣는다) → 행동에 덧붙이고 그 그라스타를 앞 칸에 고정(fitGrasta · 장비 단계 lockGrasta)
    // 장비 습득 스킬(11-12, 사용자 「그라스타 스킬이나 배지 스킬이면 장착 칸도 차지」) — m.equipSkills = [{ slot: weapon|armor|grasta|badge, item, skill }](딩님 DB, data/calc/equip_skills.json).
    //   순서에 쓰면 그 장비를 그 칸에 고정: 무기 · 방어구 = 후보를 그것 하나로(lockWeapon · lockArmor) · 그라스타 = lockGrasta · 배지 = lockBadges(optimizer)
    // 수동 효과(seq 항목 [멤버, 이름, { fx }]) — 행동이 아니라 스킬칸 · 이름 검사에서 뺀다(S.seqTurns)
    const manual = k => !!(seq[k][2] && (seq[k][2].fx || seq[k][2].sb));   // 스텔라 버스트 블록 [-1, "스텔라 버스트", { sb: true }] 도 행동 밖
    const team0 = party.map((m0, ci) => {
      let m = withGrants(m0, { grantsOf: x => x.extraGrants || [] });
      const via = { weapon: "viaW", armor: "viaA", grasta: "viaG", badge: "viaB" };
      const add = (m0.equipSkills || []).filter(e => e && e.item && e.skill && via[e.slot]).map(e => ({ ...e.skill, slot: true, via: e.item.name, [via[e.slot]]: e.item }));
      if (add.length) m = { ...m, actions: { ...m.actions, skills: [...m.actions.skills.filter(s => !add.some(a => a.name === s.name)), ...add] } };
      const has = new Map((m.actions.skills || []).map(s => [s.name, s]));
      seq.forEach(([c, n], k) => { if (c === ci && !manual(k) && !has.has(n)) throw new Error(`${m.c.nameKo}: 스킬 「${n}」 없음`); });
      const sl = [...new Set(seq.filter(([c], k) => c === ci && !manual(k)).map(([, n]) => n))].filter(n => has.get(n).slot);
      if (sl.length > 4) throw new Error(`${m.c.nameKo}: 순서에 쓴 스킬칸 스킬이 ${sl.length}개 — 스킬칸은 4개`);
      const used = sl.map(n => has.get(n));
      // 고정 장비는 후보 목록의 같은 이름 객체로(워커로 넘어온 것은 복사본 — 객체가 다르면 같은 배지가 빈 칸에 한 번 더 들어간다)
      const P0 = conf.gear ? conf.gear.poolsOf(m) : null, inP = (it, list) => (P0 && it && (P0[list] || []).find(x => x.name === it.name)) || it;
      const lw = inP((used.find(x => x.viaW) || {}).viaW, "weapons"), la = inP((used.find(x => x.viaA) || {}).viaA, "armor");
      const lb = [...new Set(used.filter(x => x.viaB).map(x => x.viaB.name))].map(n => inP(used.find(x => x.viaB && x.viaB.name === n).viaB, "badges"));
      if (lb.length > 2) throw new Error(`${m.c.nameKo}: 배지 스킬 ${lb.length}개 — 배지 칸은 2개`);
      const x = { ...fitGrasta({ ...m, gslots }, sl), slots: sl };
      if (lw) Object.assign(x, { weapon: lw, lockWeapon: lw });
      if (la) Object.assign(x, { armor: la, lockArmor: la });
      if (lb.length) Object.assign(x, { badges: [...lb, ...(x.badges || []).filter(b => b && !lb.includes(b))].slice(0, Math.max(2, lb.length)), lockBadges: lb });
      return x;
    });
    // 칸 고정을 지키는 장비 후보 — 무기 · 방어구는 고정한 것 하나
    const poolsOf = m => { const p = conf.gear.poolsOf(m); return m.lockWeapon || m.lockArmor ? { ...p, ...(m.lockWeapon ? { weapons: [m.lockWeapon] } : {}), ...(m.lockArmor ? { armor: [m.lockArmor] } : {}) } : p; };
    const outMode = conf.outGear || "atk";
    const runOf = (t, c2 = {}) => { evals++; return S.run(t, { af: null, seq }, opt, { scoreSteps: steps, ...c2 }); };
    let team = team0, cur = runOf(team);
    const O = conf.gear && (root.AEOpt || require("./optimizer.js"));
    const gearPass = (carry, force) => {
      // 대표 행동 = 목표 행동 중 지금 가장 센 것 · 목표가 없는 멤버는 순서 안 자기 행동 중 가장 센 것(장비 비교에 공격이 있어야 한다 — 없으면 무기가 다 같은 값)
      const best = ks => ks.sort((a, b) => cur.perStep[b] - cur.perStep[a])[0];
      const key = team.map((m, ci) => best(steps.filter(k => seq[k][0] === ci && !manual(k))) ?? best(seq.map((_, k) => k).filter(k => seq[k][0] === ci && !manual(k))));
      const sr = runOf(team, { snapAt: key.filter(k => k != null) });
      const top = cur.perMember.indexOf(Math.max(...cur.perMember)), topSnap = key[top] != null ? sr.snaps[key[top]] : null;
      // fx(그 멤버가 건 효과 = 정적 식에선 남에게 가는 버프)는 목표 행동 시점 장면에서 — 목표 멤버는 자기 대표 행동 직전, 목표 밖 멤버는 가장 큰 목표 행동 직전.
      //   목표 밖 멤버의 뒤쪽 행동 장면에서 가져오면 목표 행동 때 아직 없는 버프가 들어가 장비가 어긋났다(기도 순서 목표 565,694 → 504,421, 11-12)
      const isT = ci => steps.some(k => seq[k][0] === ci && !manual(k));
      const members = team.map((m, ci) => {
        const k = key[ci], sk = k != null && (m.actions.skills || []).find(s => s.name === seq[k][1]);
        const part = sk && (sk.attacks || []).find(a => !a.cond || opt.cond), sn = isT(ci) ? (k != null ? sr.snaps[k] : null) : topSnap;
        return { ...m, fx: sn ? S.liveFx(sn.live, ci) : [], attack: part ? S.toAttack(part, sk) : undefined, _contrib: null };
      });
      const punish = [...new Set([...(opt.punish || []), ...key.filter(k => k != null && steps.includes(k)).flatMap(k => S.liveStates(sr.snaps[k].live))])];   // 목표 행동 장면의 상태만(목표 밖 멤버의 뒤쪽 장면에서 걸린 독 · 페인을 목표 행동에 가정하지 않는다)
      const gopt = { ...opt, zone: (topSnap && topSnap.zone) || opt.zone, turns: key[top] != null ? sr.turnOf[key[top]] : 1, punish };
      const pre = AP.prepare(members, gopt), scale = {};
      const st = members.map(m => (AP.memberDamage(m, members, gopt, pre) || {}).perUse || 0);
      const tsc = members.map((m, i) => (st[i] > 0 && cur.perMember[i] > 0 ? cur.perMember[i] / st[i] : 0));
      members.forEach((m, i) => { scale[m.c.id] = tsc[i]; });                          // 1단계 = 목표 멤버만(목표 밖 멤버 비중 0)
      const put = gt => team.map((m, i) => { const x = gt[i]; return { ...m, weapon: x.weapon, armor: x.armor, badges: x.badges, grasta: x.grasta, special: (x.gear && x.gear.special) || [] }; });
      // 1단계는 목표 밖 멤버의 공격을 빼고 넘긴다 — 비중 0 이어도 공격이 있으면 그 멤버 칸 고르기가 개수 제한 장비를 쥐어 목표가 내려갔다(기도 순서 목표 565,694 → 480,401, 11-12)
      const fixed = m => ({ ...poolsOf(m), weapons: [m.weapon].filter(Boolean), armor: [m.armor].filter(Boolean), grasta: (m.grasta || []).filter(x => !(m.special || []).includes(x)), badges: (m.badges || []).filter(Boolean) });
      const keepOut = new Set(outMode === "keep" ? team.filter((m, i) => !isT(i)).map(m => m.c.id) : []);   // 목표 밖 장비 「저장 그대로」(11-12)
      const pools1 = m => (keepOut.has(m.c.id) ? fixed(m) : poolsOf(m));
      const g = O.partyGear(members.map((m, i) => (tsc[i] ? m : { ...m, attack: undefined })), gopt, pools1, { ...(conf.gear.conf || {}), ...(carry ? { objective: "carry", carry } : {}), scale });
      evals += g.evals;
      const prev = { team, cur };
      team = put(g.team);
      cur = runOf(team);
      if (!force && cur.score < prev.cur.score * (1 - 1e-9)) ({ team, cur } = prev);   // 정적 식은 근사 — 순서 점수가 내려가면 받지 않는다
      // 2단계 = 목표 밖 멤버(11-12) — 목표 멤버 장비는 지금 낀 것만 후보로 묶고, 목표 밖 멤버는 자기 몫이 목표 점수의 1e-3 인 비중으로 남은 장비에서 고른다.
      //   한 번에(비중 > 0) 고르면 목표 밖 멤버가 개수 제한 장비를 먼저 쥐어 목표가 내려갔다(2번째 Finish 목표 0.0114 → 0.0092억 · 넘기는 순서를 바꾸면 우츠하라 목표 −9%)
      const out = members.map((m, i) => !tsc[i] && (outMode === "spd" || st[i] > 0));
      if (outMode === "atk" && out.some(Boolean)) {
        const nt = out.filter(Boolean).length, own = new Map();
        const members2 = members.map((m, i) => ({ ...m, weapon: team[i].weapon, armor: team[i].armor, badges: team[i].badges, grasta: team[i].grasta, special: team[i].special, _contrib: null }));
        members2.forEach((m, i) => { scale[m.c.id] = out[i] ? 1e-3 * (cur.score || 1) / st[i] / nt : tsc[i]; if (!out[i]) own.set(m.c.id, fixed(m)); });
        const g2 = O.partyGear(members2, gopt, m => own.get(m.c.id) || poolsOf(m), { ...(conf.gear.conf || {}), scale });
        evals += g2.evals;
        const keep = { team, cur };
        team = put(g2.team.map((x, i) => (out[i] ? x : { ...members2[i], gear: { special: members2[i].special } })));
        cur = runOf(team);
        if (cur.score < keep.cur.score * (1 - 1e-9)) ({ team, cur } = keep);
      }
      // 속도 중심 — 멤버마다: 전부 속도 → 목표가 내려가면 목표를 받치는 장비는 지키고 나머지만 속도 → 그래도 내려가면 그대로(목표가 먼저)
      if (outMode === "spd") team.forEach((m, i) => {
        if (!out[i]) return;
        for (const keep of [false, true]) {
          const t2 = team.map((x, j) => (j === i ? { ...x, ...speedGear(x, team, poolsOf(x), keep) } : x)), r = runOf(t2);
          if (r.score >= cur.score * (1 - 1e-9)) { team = t2; cur = r; break; }
        }
      });
      // 부여 무기 — 「공격 시 적 저항 다운 · 페인/독」 무기는 정적 식이 모른다 → 순서 점수로. 다른 멤버가 든 무기는 건너뜀
      team.forEach((m, ci) => {
        if (m.lockWeapon) return;
        for (const w of (poolsOf(m).weapons || []).filter(hasInflict)) {
          if (w === team[ci].weapon || team.some((o, j) => j !== ci && o.weapon && o.weapon.name === w.name)) continue;
          const t2 = team.map((x, j) => (j === ci ? { ...x, weapon: w } : x)), r = runOf(t2);
          if (r.score > cur.score * (1 + 1e-9)) { team = t2; cur = r; }
        }
      });
    };
    if (conf.gear) {
      const tgt = team0.filter((m, ci) => steps.some(k => seq[k][0] === ci)).map(m => m.c.id);
      let best = null;
      for (const seed of [null, ...(tgt.length > 1 ? tgt : [])]) {
        team = team0; cur = runOf(team);
        if (seed) gearPass(seed, true);
        for (let r = 0; r < (conf.gearRounds ?? 2); r++) gearPass(null, false);
        if (conf.tick) conf.tick(`시작 ${seed || "기본"}: ${(cur.score / 1e8).toFixed(2)}억`);
        if (!best || cur.score > best.cur.score) best = { team, cur };
      }
      ({ team, cur } = best);
      if (conf.back && conf.back.length) opt = shuttle(conf.back, team, opt, conf, (t, o) => { evals++; return S.run(t, { af: null, seq }, o, { scoreSteps: steps }).score; }, gslots);
    }
    const fin = S.run(team, { af: null, seq }, opt, { scoreSteps: steps, explain: true });   // 마지막 한 번만 계산 근거(메모 없음)
    const runO = (t, o) => S.run(t, { af: null, seq }, o, { scoreSteps: steps }).score, sc = t => runO(t, opt);
    const contrib = conf.contrib ? { ...gearContrib(team, sc), back: backContrib(team, opt, runO) } : null;
    const fxc = conf.fxContrib ? fxContrib(team, sc) : null;
    const all = Object.values(fin.perTurn).reduce((s, v) => s + v, 0);
    return { team, slots: team.map(m => m.slots), via: team.map(m => m.slots.map(n => ((m.actions.skills || []).find(s => s.name === n) || {}).via || null)), outGear: conf.gear ? outMode : null, contrib, fxContrib: fxc, back: opt.back || [], seq, steps, score: fin.score, total: all, perStep: fin.perStep, turnOf: fin.turnOf, perTurn: fin.perTurn, perMember: fin.perMember,
      skip: seq.map((_, k) => (fin.log.find(e => e.step === k && e.skip) || {}).skip || null),
      explain: seq.map((_, k) => fin.capture.filter(x => x.step === k).map(({ ci: _c, step: _s, ...x }) => x)), evals: evals + 1 };
  }

  // 장비 기회비용(11-12, 사용자 「장비의 근거 — 약식 식」) — 칸마다 그 장비를 빼고(무기는 능력치 · 효과 0 인 같은 종류) 같은 점수 함수로 다시 잰 감소율.
  //   score(team) → 수(고점 = S.peak, 순서 = S.run). 장비가 남에게 주는 몫(공유 그라스타 · 「공격 시」 저항 다운)까지 점수 차에 들어간다
  function gearContrib(team, score) {
    const base = score(team);
    const items = team.map((m, ci) => {
      const out = [], put = patch => team.map((x, i) => (i === ci ? { ...x, ...patch, _contrib: null } : x));
      const d = (slot, it, t2) => { const v = score(t2); out.push({ slot, name: it.name, drop: base ? (base - v) / base : 0 }); };
      if (m.weapon) d("weapon", m.weapon, put({ weapon: { ...m.weapon, atk: 0, matk: 0, calc: [], fx: [], stats: {} } }));
      if (m.armor) d("armor", m.armor, put({ armor: null }));
      (m.grasta || []).forEach((g, i) => g && d("grasta", g, put({ grasta: m.grasta.filter((_, j) => j !== i), special: (m.special || []).filter(x => x !== g) })));
      (m.badges || []).forEach((b, i) => b && d("badge", b, put({ badges: m.badges.filter((_, j) => j !== i) })));
      return out;
    });
    return { base, items };
  }
  // 후열 셔틀 그라스타의 「빼면 −%」 — scoreWith(team, opt)
  function backContrib(team, opt, scoreWith) {
    const bk = opt.back || [];
    if (!bk.length) return [];
    const base = scoreWith(team, opt);
    return bk.map((b, bi) => (b.grasta || []).map((g, j) => {
      const v = scoreWith(team, { ...opt, back: bk.map((x, i) => (i === bi ? { ...x, grasta: x.grasta.filter((_, k) => k !== j) } : x)) });
      return { name: g.name, drop: base ? (base - v) / base : 0 };
    }));
  }

  // 효과 끄기(11-12, 사용자 「스킬을 고르면 쌓이는 버프 목록 — 일부 효과만 넣고 빼고 · 기여도」, Genshin Optimizer 의 조건부 토글) —
  //   keys = ["캐릭터 id|분류(sub)|스킬 이름|효과 번호"] → 그 효과 단위에 _mute(scenario.apply 가 건너뜀). 행동 단위를 복사해 원본은 그대로
  const fxKey = (m, sk, i) => `${m.c.id}|${sk.sub || ""}|${sk.name}|${i}`;   // 같은 이름이 분류만 다른 어빌리티(「(2)」)가 있어 sub 까지
  function muteTeam(party, keys) {
    if (!keys || !keys.length) return party;
    const K = new Set(keys), hit = (m, sk) => (sk.fx || []).some((u, i) => K.has(fxKey(m, sk, i)));
    return party.map(m => (!(m.actions.skills || []).some(sk => hit(m, sk)) ? m
      : { ...m, actions: { ...m.actions, skills: m.actions.skills.map(sk => (hit(m, sk) ? { ...sk, fx: sk.fx.map((u, i) => (K.has(fxKey(m, sk, i)) ? { ...u, _mute: true } : u)) } : sk)) } }));
  }
  // 효과 기여도 — 효과 하나씩 끄고 같은 점수 함수로 다시 잰 감소율(장비 gearContrib 와 같은 방식, 장비 · 스킬칸은 그대로).
  //   대상 = 스킬칸 스킬 · 그 바뀐 스킬 · 어빌리티 · 일반 공격의 효과 중 대미지에 닿을 수 있는 종류(회복 · 보호 · MP · 행동 변화 · 해제 · 게이지 · 순서 제외)
  const FX_SKIP = new Set(["heal", "guard", "cost", "action", "dispel", "af", "order"]);
  function fxContrib(team, score) {
    const base = score(team), items = [];
    team.forEach((m, ci) => {
      const sl = new Set(m.slots || []);
      for (const sk of m.actions.skills || []) {
        if (!(sl.has(sk.name) || sk.kind === "ability" || sk.kind === "normal" || (sk.kind === "variant" && sl.has(sk.from)))) continue;
        (sk.fx || []).forEach((u, i) => {
          if (u._mute || FX_SKIP.has(u.k)) return;
          const v = score(team.map((x, j) => (j === ci ? muteTeam([x], [fxKey(x, sk, i)])[0] : x))), drop = base ? (base - v) / base : 0;
          if (Math.abs(drop) > 1e-6) items.push({ key: fxKey(m, sk, i), ci, skill: sk.name, i, drop });
        });
      }
    });
    return { base, items };
  }
  // 후열 셔틀(11-12 화면 연결 — 사용자 「후열 2개는 순전히 연성 셔틀」) — back = [{c, cc}] 은 공격 · 효과 없이 공유 그라스타만 나른다.
  //   칸마다 공유 그라스타 후보(장비 후보 중 share · 광석 아님)를 바꿔 점수가 오르면 채택(optimize 의 셔틀과 같은 규칙 — 획득 수 limit 은 전방이 낀 것까지 센다). scoreWith(team, opt)
  function shuttle(backIn, team, opt, conf, scoreWith, gslots) {
    const back = backIn.map(b => ({ c: b.c, cc: b.cc, pool: b.pool || (conf.gear.poolsOf(b).grasta || []).filter(g => g.share && !g.ore), grasta: Array(gslots).fill(null) }));
    const used = g => [...team.flatMap(m => m.grasta || []), ...back.flatMap(b => b.grasta)].filter(x => x && (x.base || x.name) === (g.base || g.name)).length;
    const put = () => ({ ...opt, back: back.map(b => ({ c: b.c, cc: b.cc, grasta: b.grasta.filter(Boolean) })) });
    let best = scoreWith(team, put());
    for (let pass = 0; pass < 3; pass++) {
      let moved = false;
      for (const b of back) for (let k = 0; k < gslots; k++) for (const g of [null, ...b.pool]) {
        const was = b.grasta[k];
        if (g === was || (g && used(g) >= (g.limit ?? Infinity))) continue;
        b.grasta[k] = g;
        const q = scoreWith(team, put());
        if (q > best * (1 + 1e-9)) { best = q; moved = true; } else b.grasta[k] = was;
      }
      if (conf.tick) conf.tick(`후열 셔틀 ${pass + 1}바퀴`);
      if (!moved) break;
    }
    return put();
  }

  // 파티원 추천(11-12, 사용자 「파티원 2명을 고정할 때 대미지 극대화가 되는 파티원 조합 및 스킬 목록」) — 고점(반복) 점수, 장비 없이(기본 무기).
  //   fixed = 고정 멤버(lock 스킬칸 그대로) · cands = 후보 멤버(actions 포함) · conf = { open(채울 칸 수), focus(fixed 안 번호 → 그 멤버 몫), beam(2), refine(5), top(5), gear · grantsOf(그라스타 단계), tick }
  //   빈 칸마다: 후보 전원을 시작 스킬칸으로 고점 1회(≈13ms) → 상위 refine 명만 그 멤버 스킬칸을 고른다(optimizePeak only) → 갈래 beam 개를 다음 칸으로.
  //   같은 캐릭터의 다른 스타일은 한 파티에 못 선다(fam)
  function recommend(fixed, cands, opt, conf = {}) {
    const open = conf.open ?? Math.max(0, 4 - fixed.length), beamN = conf.beam || 2, refineN = conf.refine || 5, focus = conf.focus ?? null;
    const fam = id => id.replace(/(_alter)?(_as|_es)?$/, "");
    const scoreOf = r => (focus == null ? r.score : r.perMember[focus] + 1e-6 * (r.score - r.perMember[focus]));
    let evals = 0;
    const base = optimizePeak(fixed, opt, { passes: 2, pairMoves: false });
    evals += base.evals;
    let beams = [{ team: base.team, q: base.scores.repeat }];
    for (let s = 0; s < open; s++) {
      const next = [];
      beams.forEach((b, bi) => {
        const taken = new Set(b.team.map(m => fam(m.c.id)));
        // 거르기 = 기본 시작 칸(준비 2 + 공격 2) 상위 refine 명 + 지원 위주 시작 칸(준비 스킬부터 4)으로 재야만 그 컷을 넘는 후보(최대 3명)
        //   한 가지만 재면 버프 3~4개짜리 서포터가 버프 절반으로 재져 빠진다. 다만 다듬기 출발점을 지원 위주로 바꾸면 좌표 하강이 더 낮은 곳에 멈출 수 있어
        //   (11-12 실측: 우츠하라 극대화 6.00억 → 3.85억) 기본 상위는 기본 칸에서 출발 — 다듬는 후보 = 옛 거르기 후보 + 덧붙인 후보
        const pool = cands.filter(c => !taken.has(fam(c.c.id))).map(c => {
          const s0 = startSlots(c, {}), s1 = initialSlots(c, { setupFirst: true });
          evals++;
          const q0 = scoreOf(S.peak([...b.team, { ...c, slots: s0 }], opt));
          const q1 = s1.join("|") === s0.join("|") ? -Infinity : (evals++, scoreOf(S.peak([...b.team, { ...c, slots: s1 }], opt)));
          return { c, q0, q1, s0, s1 };
        });
        const byA = [...pool].sort((x, y) => y.q0 - x.q0).slice(0, refineN), cut = byA.length ? byA[byA.length - 1].q0 : -Infinity, inA = new Set(byA);
        const byB = pool.filter(x => !inA.has(x) && x.q1 > cut).sort((x, y) => y.q1 - x.q1).slice(0, conf.refineSupport ?? 3);
        const scr = [...byA.map(x => ({ c: x.c, sl: x.s0 })), ...byB.map(x => ({ c: x.c, sl: x.s1 }))];
        scr.forEach((x, k) => {
          const r = optimizePeak([...b.team, { ...x.c, slots: x.sl }], opt, { passes: 2, pairMoves: false, only: [b.team.length], focus });
          evals += r.evals;
          next.push({ team: r.team, q: scoreOf({ score: r.scores.repeat, perMember: r.perMember }), perMember: r.perMember });
          if (conf.tick) conf.tick(`${s + 1}번째 빈 칸 · 갈래 ${bi + 1}/${beams.length} · ${x.c.c.nameKo} (${k + 1}/${scr.length})`);
        });
      });
      const seen = new Set();
      beams = next.sort((x, y) => y.q - x.q).filter(x => { const k = x.team.map(m => m.c.id).sort().join(","); return !seen.has(k) && seen.add(k); }).slice(0, s === open - 1 ? (conf.top || 5) : beamN);
    }
    // 그라스타 단계(conf.gear — 워커가 무기 고정 · 방어구 · 배지 없는 풀을 준다, 11-12 사용자 「장비 디테일은 못 맞춰도 그라스타까지는」) — 최종 상위 조합만, 갈래 하나로 맞춘 뒤 다시 줄 세운다
    if (conf.gear) beams = beams.map((b, k) => {
      // 스킬칸 그대로 장비만(passes · branchPasses 0) — 칸을 다시 고르면 조합당 44초 → 17초 · 점수 차 0.02%(11-12 애쉬티어 조합 실측)
      const r = optimizePeak(b.team, opt, { passes: 0, branchPasses: 0, pairMoves: false, carryStarts: false, stateMoves: false, rebranch: false, focus, gear: conf.gear, grantsOf: conf.grantsOf });
      evals += r.evals;
      if (conf.tick) conf.tick(`그라스타 맞추기 ${k + 1}/${beams.length}`);
      return { team: r.team, q: scoreOf({ score: r.scores.repeat, perMember: r.perMember }), q0: b.q, perMember: r.perMember };
    }).sort((x, y) => y.q - x.q);
        return { combos: beams.map(b => ({ ids: b.team.map(m => m.c.id), slots: b.team.map(m => m.slots), q: b.q, q0: b.q0 ?? null, perMember: b.perMember || null,
      grasta: conf.gear ? b.team.map(m => (m.grasta || []).filter(Boolean).map(g => g.name)) : null })), evals };
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
    // 후열 셔틀 그라스타 — 빼면 A 가 얼마 주나(전부 파티 몫)
    const backItems = (opt.back || []).map((b, bi) => (b.grasta || []).map((g, j) => {
      const r = S.run(team, plan, { ...opt, back: opt.back.map((x, i) => (i === bi ? { ...x, grasta: x.grasta.filter((_, k) => k !== j) } : x)) }, sc);
      const all = base.score - r.score;
      return { kind: "그라스타(후열)", name: g.name, total: all, own: 0, party: all, pct: base.score ? all / base.score : 0 };
    }));
    return { base: base.score, perMember: base.perMember, items: out, backItems };
  }

  const api = { optimize, optimizePeak, optimizeSeq, gearContrib, fxContrib, muteTeam, recommend, candidates, initialSlots, useful, contributions, grantSkill, withGrants, fitGrasta };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AEBuild = api;
})(typeof window !== "undefined" ? window : globalThis);
