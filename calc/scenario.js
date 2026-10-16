// 파티 빌드 시나리오 실행기 (2026-10-17, plan ae-party-build E1) — 규칙 docs/ae-turn-sim.md §2.2~2.5
//   입력: 파티(전방 멤버 = party_calc 계산 멤버 + actions(data/calc/actions/<id>.json 한 문서) + slots(스킬 이름 4개)),
//         계획 plan = { af: [[멤버마다 스킬 이름 6개]] | null, turns: [[멤버마다 그 턴 스킬 이름]] }, opt(적 · 존 · 환경 · 버디 …)
//   진행: 전투 시작(패시브 · 전투 시작 효과) → (AF 면) T1 AF: 좌→우 순환 시전(점수 밖) → T1 턴 종료 → T2… 일반 턴(속도순 1회씩)
//   효과 타임라인: 시전자 × 효과(종류 · 스탯/이름 · 방향 · 편) 한 칸 — 다시 걸면 덮어쓰기, 최고 누적이면 겹 +1(값은 party_calc 가 반감 누적으로),
//     turns = 건 턴이 0턴, 그 턴 + N 턴 끝 만료(0 = 그 턴 끝) · times = 대미지 행동마다 1 소모(속성 공격 · 크리율) · 영구는 null
//   대미지: 공격 순간 살아 있는 효과를 시전자별 fx 로 묶어 party_calc.memberDamage(근사) — 정적 추정과 같은 식. 스킬의 효과는 공격 뒤에 건다
//   브라우저(window.AEScenario) · node 공용. 테스트: _tools/character/tests/test_scenario.cjs
(function (root) {
  "use strict";
  const P = root.AEParty || require("./party_calc.js");
  const C = root.AECalc || require("./ae_calc.js");
  const ZONE_KO = { "열화진": "Raging Fire Stance", "수천진": "Sacred Water Stance", "지열진": "Torn Earth Stance", "풍왕진": "Wind King Stance",
    "초뢰진": "Thundering Stance", "각음진": "Biting Shade Stance", "휘정진": "Crystalline Stance", "황참진": "Dazzling Slash Stance",
    "순돌진": "Piercing Flash Stance", "굉타진": "Roaring Bash Stance", "환마진": "Magic Fates Stance", "월광진": "Moonlight Stance",
    "섬격진": "Flash Strike Stance", "성해진": "Sea of Stars Stance", "견수진": "Defense Wall", "쌍격진 참마": "Double Strike Stance: Magic Slash",
    "쌍격진 참돌": "Double Strike Stance: Piercing Slash" };
  const ENGINE = new Set(["stat_pct", "dmg", "buff", "ailment", "stack"]);

  // 행동 단위 공격 → party_calc 공격(1타 위력 · 타수 · dep)
  function toAttack(a, sk) {
    const magic = a.atk === "마법";
    const dep = a.dep === "pwr" && magic ? "magicpwr" : magic ? "magic" : a.dep === "int" ? "int" : a.dep === "spd" ? "spd" : "pwr";
    const mult = a.power ?? a.mult, multMax = a.powerMax ?? a.multMax;
    return { skill: sk.name, mult, multMax, hits: a.hits || 1, element: a.element || "", atk: a.atk || "", scope: a.scope || "", dep,
      conds: a.conds, mp: sk.mp || 0, sec: "skills", _sure: !!a.sureCrit, _fixed: !!a.fixed };
  }
  const sideOf = u => (/적/.test(u.tc || "") ? "e" : "a");
  const slotKey = (caster, u) => [caster, u.k, (u.stats || []).join(",") || u.name || u.what || "", u.dir || "", sideOf(u)].join("|");

  function newSim(party, opt, memo) {
    return { party, opt, memo, turn: 0, af: false, zone: opt.zone || null, live: new Map(), log: [], dmg: [] };
  }
  // 효과 걸기 — 같은 칸은 덮어쓰기(누적형은 겹 +1), 지속 갱신
  // 파티 구성 조건(위키 need: 전방에 특성 n명 이상) — 실제 전방 멤버로 판정(others:false 면 본인 포함)
  function needOk(sim, ci, need) {
    if (!need) return true;
    const ts = need.traits || [];
    const cnt = sim.party.filter((m, i) => (need.others ? i !== ci : true) && ((m.c && m.c.traits) || []).some(t => ts.includes(t))).length;
    return cnt >= (need.n || 1);
  }
  function apply(sim, ci, u, skName) {
    if (u.cond && !sim.opt.cond) return;
    if (!needOk(sim, ci, u.need)) return;
    if (u.k === "zone") { const z = (sim.opt.zones || []).find(x => x.name === ZONE_KO[u.name]); if (z) sim.zone = z; return; }
    if (!ENGINE.has(u.k)) return;
    const key = slotKey(ci, u), old = sim.live.get(key);
    // 겹은 같은 스킬을 다시 걸 때만 오른다 — 다른 스킬이 같은 칸을 덮어쓰면 1부터(전에는 앞 스킬 겹을 이어받아 첫 시전이 2겹이 됐다)
    const stacks = u.maxStack > 1 ? Math.min(u.maxStack, (old && old.skill === skName ? old.stacks : 0) + 1) : 1;
    const until = u.turns == null ? (u.times ? Infinity : Infinity) : sim.turn + u.turns;    // 만료 = 그 턴 끝
    sim.live.set(key, { ci, u, skill: skName, stacks, until, times: u.times || null });
  }
  // 살아 있는 효과 → 시전자별 fx(누적은 A + A/2·(n−1) 한 값)
  function fxOf(sim, ci, extra) {
    const out = [];
    for (const e of sim.live.values()) {
      if (e.ci !== ci) continue;
      const v = typeof e.u.value === "number" && e.stacks > 1 ? +C.halfStack(e.u.value, e.stacks).toFixed(2) : e.u.value;
      out.push({ ...e.u, value: v, base: undefined, _skill: e.skill });
    }
    return extra ? out.concat(extra) : out;
  }
  // 공격 1회 — 그 순간 효과로 근사 기대 대미지(perUse). conf.memo(Map)가 있으면 같은 상태(공격자 · 스킬 · 살아 있는 효과 · 존 · 턴)는 다시 안 센다
  //   — 계획기 · 빌드 탐색은 같은 상태를 수없이 지난다. 장비가 바뀌면 memo 를 새로(키에 장비는 없다)
  function attack(sim, ci, sk, part) {
    const memo = sim.memo;
    let key;
    if (memo) {
      const live = [...sim.live.entries()].map(([k, e]) => `${k}#${e.stacks}#${e.u.value}`).sort().join(";");
      key = `${ci}|${sk.name}|${sk.attacks.indexOf(part)}|${(sim.zone || {}).name || ""}|${sim.turn}|${sim.af ? 1 : 0}|${live}`;
      if (memo.has(key)) return memo.get(key);
    }
    const v = attackRaw(sim, ci, sk, part);
    if (memo) memo.set(key, v);
    return v;
  }
  function attackRaw(sim, ci, sk, part) {
    const atk = toAttack(part, sk);
    const members = sim.party.map((m, i) => ({ ...m, fx: fxOf(sim, i, i === ci && atk._sure ? [{ k: "buff", name: "크리티컬 발생 확정", _skill: sk.name, _atkItem: true }] : null), _contrib: null }));
    const m = { ...members[ci], attack: atk };
    members[ci] = m;
    const r = P.memberDamage(m, members, { ...sim.opt, zone: sim.zone, turns: sim.turn, af: sim.af });
    return r ? r.perUse : 0;
  }
  // 행동 소모형(times) — 대미지 행동 1회마다. 크리율은 물리/마법 각각
  function consume(sim, ci, atk) {
    const magic = atk.atk === "마법";
    for (const [k, e] of sim.live) {
      if (!e.times || e.ci == null) continue;
      const st = (e.u.stats || [])[0] || "";
      const holderGets = sideOf(e.u) === "a" && (e.u.tc === "아군 전체" || e.ci === ci);
      if (!holderGets) continue;
      if (/크리티컬율/.test(st) && /마법/.test(st) !== magic) continue;
      if (--e.times <= 0) sim.live.delete(k);
    }
  }
  function act(sim, ci, name, scored) {
    const m = sim.party[ci], sk = (m.actions.skills || []).find(s => s.name === name);
    if (!sk) return 0;
    let d = 0;
    const parts = (sk.attacks || []).filter(a => !a.cond || sim.opt.cond);   // 조건부 공격(「스텔라 버스트 시」 · 전술 레벨 50 …)은 조건부 효과 포함일 때만
    for (const a of parts) d += attack(sim, ci, sk, a);
    if (parts.length) consume(sim, ci, parts[0]);
    for (const u of sk.fx || []) if (!u.timing || u.timing === "use") apply(sim, ci, u, sk.name);
    sim.log.push({ turn: sim.turn, af: sim.af, who: m.c.nameKo, skill: name, dmg: Math.round(d) });
    if (scored) sim.dmg[sim.turn] = (sim.dmg[sim.turn] || 0) + d;
    return d;
  }
  function endTurn(sim) {
    for (const [k, e] of sim.live) if (e.until <= sim.turn) sim.live.delete(k);
  }
  function battleStart(sim) {
    sim.party.forEach((m, ci) => {
      for (const sk of m.actions.skills || [])
        if (sk.kind === "ability") for (const u of sk.fx || []) if (u.timing === "always" || u.timing === "battleStart" || !u.timing) apply(sim, ci, { ...u, turns: u.timing === "battleStart" ? u.turns : null }, sk.name);
    });
  }
  // 속도순(선제 · 후공 상태는 다음 판) — 같은 속도는 좌→우
  const order = sim => sim.party.map((m, i) => i).sort((a, b) => ((sim.party[b].stats || {}).spd || 0) - ((sim.party[a].stats || {}).spd || 0) || a - b);

  // 시나리오 실행 → { perTurn: {턴: 대미지}, score, log }
  //   plan.af = 멤버마다 6개(없으면 AF 없음) · plan.turns = 턴마다 멤버별 스킬 · conf.scoreTurns = 점수에 넣는 턴(기본: AF 면 2~4, 아니면 계획의 모든 턴) · conf.memo = 대미지 메모(Map)
  function run(party, plan, opt, conf = {}) {
    const sim = newSim(party, opt, conf.memo || null);
    battleStart(sim);
    sim.turn = 1;
    let t0 = 1;
    if (plan.af) {
      sim.af = true;
      const n = Math.max(...plan.af.map(x => x.length));
      for (let k = 0; k < n; k++) party.forEach((m, ci) => { if (plan.af[ci] && plan.af[ci][k]) act(sim, ci, plan.af[ci][k], false); });
      sim.af = false;
      endTurn(sim);
      t0 = 2;
    }
    (plan.turns || []).forEach((row, i) => {
      sim.turn = t0 + i;
      for (const ci of order(sim)) if (row[ci]) act(sim, ci, row[ci], true);
      endTurn(sim);
    });
    const perTurn = Object.fromEntries(Object.entries(sim.dmg).map(([t, v]) => [t, v]));
    const want = conf.scoreTurns || Object.keys(perTurn).map(Number);
    return { perTurn, score: want.reduce((s, t) => s + (perTurn[t] || 0), 0), log: sim.log, live: sim.live };
  }

  const api = { run, toAttack, ZONE_KO };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AEScenario = api;
})(typeof window !== "undefined" ? window : globalThis);
