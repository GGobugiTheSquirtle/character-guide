// 원작 어나더에덴 턴 시뮬레이터 v0 (2026-10-08) — 규칙 명세 · 시트 형식: docs/ae-turn-sim.md
//   행동 시트(data/sheets/<id>.json)를 턴 순서대로 실행한다: 전투 시작 → (턴 시작 좌→우 → 선제/보통/후공 속도순 ±10% → 턴 종료 → 지속 감소) 반복
//   대미지는 ae_calc.damage, 장비 효과는 party_calc.equipFor 그대로(정적 계산과 같은 식). HP · AF · SB · 교대는 v0 밖
//   브라우저(window.AETurn) · node 공용. 테스트: _tools/character/tests/test_turn_sim.cjs
(function (root) {
  "use strict";
  const C = root.AECalc || require("./ae_calc.js");
  const P = root.AEParty || require("./party_calc.js");
  const ELEMS = ["불", "물", "땅", "바람", "번개", "그림자", "결정"];
  const PHYS = ["베기", "찌르기", "타격"];
  const TIER = { pre: 0, normal: 1, delayed: 2 };

  function rng(seed) { let s = (seed >>> 0) || 1; return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296; }

  // ── 버프 칸: 시전자 × 출처 × 그룹 — 같은 칸은 덮어쓰기 (Buffs and Debuffs · Overwriting) ──
  function putBuff(unit, b) {
    const k = `${b.stat}|${b.caster}|${b.src}`, old = unit.buffs.get(k);
    if (b.max_stack) b.n = Math.min(b.max_stack, (old && old.max_stack ? old.n : 0) + 1);   // 「Max Stacks 3」 = 반감 중첩
    unit.buffs.set(k, b);
  }
  const slotV = b => (b.max_stack ? C.halfStack(Math.abs(b.v), b.n) * Math.sign(b.v) : b.v);
  function durOf(d) {
    if (!d) return { left: 0 };
    if (d.perm) return { left: Infinity };
    if (d.until) return { left: 0 };
    if (d.moves) return { left: d.turns != null ? d.turns : Infinity, moves: d.moves };
    if (d.turns_minus) return { left: d.turns_minus - 1 };
    return { left: d.turns != null ? d.turns : 0 };
  }
  // 그룹 순효과 — 스킬 · VC 칸 체감, 장비 가산, 이름 붙은 % 축적 가산 → ae_calc.groupNet (상한 100%)
  function net(unit, stats, sim) {
    const g = { buffs: [], debuffs: [], named: [], equip: [] };
    for (const b of unit.buffs.values()) {
      if (!stats.includes(b.stat) || b.flat) continue;
      const v = slotV(b);
      if (b.src === "equip") g.equip.push(v / 100);
      else if (v >= 0) g.buffs.push(v / 100); else g.debuffs.push(-v / 100);
    }
    for (const [name, n] of Object.entries(unit.stacks || {})) {
      const def = sim.stackDef[name];
      for (const p of (def && def.per) || []) if (stats.includes(p.stat) && p.v) g.named.push(p.v * n / 100);
    }
    return C.groupNet(g);
  }
  const sumBuff = (unit, stat) => [...unit.buffs.values()].filter(b => b.stat === stat).reduce((s, b) => s + (b.flat ? 0 : b.v), 0);

  // ── 조건 ──
  function check(conds, sim, a, ctx = {}) {
    for (const c of conds || []) if (!one(c, sim, a, ctx)) return false;
    return true;
  }
  function cmp(x, c) {
    if (c.eq != null && x !== c.eq) return false;
    if (c.gte != null && x < c.gte) return false;
    if (c.lte != null && x > c.lte) return false;
    return true;
  }
  function one(c, sim, a, ctx) {
    if (c.zone) return !!sim.zone && (c.zone === "any" || sim.zone.name.includes(c.zone)) && (c.awakened == null || !!sim.zone.awakened === c.awakened);
    if (c.state) return !!a.states[c.state];
    if (c.state_turn) return !!a.states[c.state_turn] && cmp(a.states[c.state_turn].age, c);
    if (c.stack) return cmp(a.stacks[c.stack] || 0, c);
    if (c.front) return cmp(sim.party.filter(m => (m.traits || []).some(t => c.front.traits.includes(t))).length, c.front);
    if (c.pos) return c.pos === "front";
    if (c.turn) return cmp(sim.turn, c.turn);
    if (c.first_use) return !(a.used[ctx.skill] > 0);
    if (c.used_turn) return a.usedTurn[c.used_turn] != null && sim.turn - a.usedTurn[c.used_turn] === -(c.rel || 0);
    if (c.consumed) return cmp((ctx.consumed || {})[c.consumed] || 0, c);
    if (c.target_status) return !!sim.enemy.statuses[c.target_status];
    if (c.hp) return c.hp.gte != null ? c.hp.gte <= 100 : c.hp.lte >= 100;      // v0: HP 는 늘 가득
    if (c.enemies) return cmp(1, c.enemies);
    if (c.attacked_this_turn) return c.attacked_this_turn === "self" ? sim.attacked.has(a.id) : sim.attacked.size > 0;
    if (c.chance != null) return sim.rand() < c.chance;
    return false;                                                                // af · sb · text — 모델 밖
  }
  const stepOk = (s, sim, a, ctx) => check(s.if, sim, a, ctx) && !(s.unless && s.unless.length && check(s.unless, sim, a, ctx));

  // ── 대상 ──
  function targets(sim, a, to) {
    if (to === "enemy" || to === "enemies") return [sim.enemy];
    if (to === "party") return sim.party;
    const i = sim.party.indexOf(a);
    if (to === "right") return sim.party.slice(i + 1, i + 2);
    if (to === "left") return i > 0 ? [sim.party[i - 1]] : [];
    if (to === "sides") return [sim.party[i - 1], sim.party[i + 1]].filter(Boolean);
    return [a];
  }

  // ── 대미지 — 지금 상태로 공격 step 한 번의 기대값 ──
  const ATK_OF = { 검: "베기", 도: "베기", 도끼: "베기", 창: "찌르기", 활: "찌르기", 권갑: "타격", 망치: "타격", 지팡이: "마법" };
  function damageOf(sim, a, step, ctx = {}) {
    const elem = step.elem && step.elem !== "없음" ? step.elem : null, type = step.type || "베기";
    const dep = step.dep || (type === "마법" ? "magic" : "pwr");
    const magic = dep === "magic" || dep === "magicpwr";
    const atk = { element: elem, atk: type, dep };
    const en = sim.enemy, aff = P.affinityOf(en.data, atk);
    const punish = Object.keys(en.statuses).filter(s => /^(Pain|Poison)$/.test(s)).map(s => s.toLowerCase());
    const eq = P.equipFor(a.gear, atk, { zone: sim.zone, maxHp: true, punish, _weak: aff === "weak" });
    const st = { ...a.stats };
    for (const [k, v] of Object.entries(eq.stats)) st[k] = (st[k] || 0) + v;
    for (const [name, n] of Object.entries(a.stacks)) for (const p of (sim.stackDef[name] || {}).per || []) if (p.flat) st[KEY[p.stat] || p.stat] = (st[KEY[p.stat] || p.stat] || 0) + p.flat * n;
    for (const b of a.buffs.values()) if (b.flat) st[KEY[b.stat] || b.stat] = (st[KEY[b.stat] || b.stat] || 0) + b.v;
    const typeStats = ["속성 공격", ...(elem ? [elem + " 속성 공격"] : [])];
    const groups = [net(a, typeStats, sim), net(a, ["대미지"], sim)];
    const focus = [...a.buffs.values()].filter(b => b.stat === (magic ? "정신 통일" : "심기일체"));
    const special = [];
    if (focus.length) special.push(C.mentalFocus(st.mp || 0, [Math.max(...focus.map(b => b.v / 100))]));
    if ([...a.buffs.values()].some(b => b.stat === "하극상") && en.data.lv) special.push(Math.min(1, en.data.lv * en.data.lv / 200 / 100));
    if (special.length) groups.push(C.focusGroup(special));
    const skillFx = [...eq.skillFx];
    for (const [name, s] of Object.entries(a.states)) for (const p of (sim.stateDef[name] || {}).per || []) if (p.stat === "대미지 배율" && p.x) skillFx.push(p.x - 1);
    for (const b of a.buffs.values()) if (b.stat === "대미지 배율") skillFx.push(b.v / 100);
    let zone = P.zoneMult(sim.zone, atk);
    if (sim.zone && sim.zone.awakened && zone > 0) zone *= 2;                                // 각성 = 증가 효과 2배
    const physStats = ["물리 저항", type + " 저항"], typeRes = ["속성 저항", ...(elem ? [elem + " 속성 저항"] : [])];
    let mult = step.mult || 0;
    if (step.scale) {
      const n = ctx.consumed && ctx.consumed[step.scale.by] != null ? ctx.consumed[step.scale.by] : (a.stacks[step.scale.by] || 0);
      if (step.scale.table) mult = step.scale.table[Math.min(n, step.scale.table.length - 1)];
      else mult *= 1 + ((step.scale.max_x || 1) - 1) * Math.min(1, n / step.scale.max_n);
    }
    const o = {
      dep, elemental: !!elem, stat: st, weapon: { atk: (a.weapon || {}).atk || 0, matk: (a.weapon || {}).matk || 0 },
      buff: { pwr: net(a, ["힘"], sim), int: net(a, ["지능"], sim), spd: net(a, ["속도"], sim) },
      enemy: { def: (en.data.end || 0) * (1 - Math.max(0, -net(en, ["내구"], sim))), mdef: (en.data.spr || 0) * (1 - Math.max(0, -net(en, ["정신"], sim))) },
      affinity: aff, weakBuff: sumBuff(a, "약점 배율"), skillMult: mult / 100, skillFx, zone,
      resDown: { phys: -net(en, physStats, sim), type: -net(en, typeRes, sim), magic: -net(en, ["마법 저항"], sim) },
      groups, punish: eq.punish, equip: eq.equip, single: step.target === "one" || step.target === "random", rand: "avg",
    };
    const critDmg = (magic ? sumBuff(a, "마법 크리티컬 대미지") : sumBuff(a, "크리티컬 대미지")) / 100 + (magic ? eq.mcritDmg : eq.critDmg);
    const critRate = (magic ? sumBuff(a, "마법 크리티컬율") : sumBuff(a, "크리티컬율")) / 100 + (magic ? eq.mcrit : eq.crit)
      + Object.entries(a.stacks).reduce((s, [n, k]) => s + ((sim.stackDef[n] || {}).per || []).filter(p => p.stat === (magic ? "마법 크리티컬율" : "크리티컬율") && p.v).reduce((t, p) => t + p.v * k / 100, 0), 0);
    const sure = step.sure_crit || [...a.buffs.values()].some(b => b.stat === "크리티컬 확정") || onAttackStack(sim, a, step).some(d => d.sure_crit);
    const normal = C.damage({ ...o, crit: false }).total, crit = C.damage({ ...o, crit: true, critDmg }).total;
    const p = sure ? 1 : magic ? Math.min(1, Math.max(0, critRate)) : C.critChance({ lck: st.lck, critRate });
    return { expected: p * crit + (1 - p) * normal, p, aff, zone, o };
  }
  // 공격할 때 반응하는 축적 정의(on_attack: {type?, consume, sure_crit?})
  const onAttackStack = (sim, a, step) => Object.keys(a.stacks).map(n => ({ n, ...((sim.stackDef[n] || {}).on_attack || {}) }))
    .filter(d => d.consume != null && (!d.type || d.type === step.type));
  const KEY = { 힘: "pwr", 지능: "int", 속도: "spd", 행운: "lck", 내구: "end", 정신: "spr", MP: "mp", HP: "hp" };

  // 행동 소모형 버프 — 대미지 행동 1회마다 1 (속성 공격 · 크리율). 물리 크리율은 물리, 마법 크리율은 마법 공격만
  function consumeMoves(a, step) {
    const magic = step.type === "마법";
    for (const [k, b] of a.buffs) {
      if (b.moves == null) continue;
      if (b.stat === "크리티컬율" && magic) continue;
      if (b.stat === "마법 크리티컬율" && !magic) continue;
      if (--b.moves <= 0) a.buffs.delete(k);
    }
  }

  // ── step 실행 ──
  function runSteps(sim, a, skill, ctx) {
    ctx.consumed = {};
    let dmg = 0, attacked = false;
    for (const s of skill.steps || []) {
      if (!stepOk(s, sim, a, { ...ctx, skill: skill.name, consumed: ctx.consumed })) continue;
      if (s.once && a.onceDone.has(skill.name + "|" + s.do)) continue;
      if (s.once) a.onceDone.add(skill.name + "|" + s.do);
      const d = s.dur ? durOf(s.dur) : null;
      if (s.do === "attack" || (s.do === "repeat" && ctx.lastAttack)) {
        const st = s.do === "attack" ? s : ctx.lastAttack;
        for (let i = 0; i < (s.do === "repeat" ? s.n || 1 : 1); i++) {
          const r = damageOf(sim, a, st, ctx);
          dmg += r.expected;
          sim.log.push({ t: sim.turn, who: a.name, skill: skill.name + (s.do === "repeat" ? " (재행동)" : ""), dmg: Math.round(r.expected), aff: r.aff, zone: r.zone, p: +r.p.toFixed(2) });
          for (const d of onAttackStack(sim, a, st)) { a.stacks[d.n] -= d.consume; if (a.stacks[d.n] <= 0) delete a.stacks[d.n]; }
        }
        ctx.lastAttack = st;
        attacked = true;
      } else if (s.do === "buff") {
        for (const u of targets(sim, a, s.to)) putBuff(u, { stat: s.stat, v: s.v ?? s.flat, flat: s.flat != null, caster: a.id, src: s.src || "skill", max_stack: s.max_stack, ...d });
      } else if (s.do === "stack") {
        for (const u of targets(sim, a, s.to)) {
          const max = (sim.stackDef[s.name] || {}).max || Infinity;
          u.stacks[s.name] = Math.min(max, (u.stacks[s.name] || 0) + (s.n || 1));
        }
      } else if (s.do === "consume") {
        const have = a.stacks[s.name] || 0, n = s.n === "all" ? have : Math.min(have, s.n || 1);
        ctx.consumed[s.name] = n;
        a.stacks[s.name] = have - n;
        if (!a.stacks[s.name]) delete a.stacks[s.name];
      } else if (s.do === "state") {
        for (const u of targets(sim, a, s.to)) {
          if (s.end) delete u.states[s.name];
          else u.states[s.name] = { ...durOf(s.dur || { perm: true }), age: 1 };
        }
      } else if (s.do === "zone") {
        if (!(sim.zone && sim.zone.awakened)) {
          const z = sim.zoneDb.find(x => x.name === s.name);
          if (z) sim.zone = { ...z, awakened: false };
        }
      } else if (s.do === "awaken") {
        if (sim.zone && !sim.zone.awakened && (s.need == null || sim.zone.name.includes(s.need))) sim.zone = { ...sim.zone, awakened: true, left: (s.turns || 2) - 1 };
      } else if (s.do === "status") {
        for (const u of targets(sim, a, s.to)) if (!(u.immune && u.immune.has(s.name))) u.statuses[s.name] = durOf(s.dur || { turns: 1 }).left;
      }
    }
    return { dmg, attacked };
  }

  // ── 행동 고르기 ──
  const isSetup = sk => (sk.steps || []).every(s => s.do !== "attack") && (sk.steps || []).some(s => ["buff", "zone", "awaken", "state", "stack", "status"].includes(s.do));
  function usable(sim, a, sk) {
    return sk.kind === "active" && (sk.mp || 0) <= a.mp && check(sk.need, sim, a, { skill: sk.name });
  }
  function estimate(sim, a, sk) {
    let v = 0;
    for (const s of sk.steps || []) if (s.do === "attack" && stepOk(s, sim, a, { skill: sk.name })) {
      const ctx = { consumed: {} };
      for (const t of sk.steps) if (t.do === "consume" && stepOk(t, sim, a, { skill: sk.name })) ctx.consumed[t.name] = t.n === "all" ? (a.stacks[t.name] || 0) : Math.min(a.stacks[t.name] || 0, t.n || 1);
      v += damageOf(sim, a, s, ctx).expected * (s.repeat || 1);
    }
    return v;
  }
  function choose(sim, a) {
    const acts = a.sheet.skills.filter(sk => usable(sim, a, sk));
    const plan = a.rotation && a.rotation[(sim.turn - 1) % a.rotation.length];
    if (plan) { const sk = acts.find(x => x.name === plan); if (sk) return sk; }
    // 자동: 아직 안 쓴 준비 스킬(버프 · 존 · 디버프 · 모드) 하나 → 그다음 가장 센 공격
    const setup = acts.find(sk => isSetup(sk) && !a.used[sk.name]);
    if (setup) return setup;
    let best = null, bv = -1;
    for (const sk of acts) { const v = estimate(sim, a, sk); if (v > bv) { bv = v; best = sk; } }
    return best || a.basic;
  }

  // ── 시뮬레이션 ──
  // members: [{ id, name, traits, stats(장비 제외), weapon, gear[], sheet, rotation? }] (전방 왼쪽부터), enemy: data/calc enemies 행
  function simulate(members, enemy, opt = {}) {
    const turns = opt.turns || 5, rand = rng(opt.seed || 1);
    const sim = { turn: 0, rand, zone: null, zoneDb: opt.zoneDb || [], log: [], order: [], stackDef: {}, stateDef: {}, attacked: new Set() };
    sim.enemy = { id: "enemy", name: enemy.name, data: enemy, buffs: new Map(), stacks: {}, states: {}, statuses: {},
      immune: new Set(opt.immune || (/Boss|Horror/.test(enemy.type || "") ? ["Stun", "Sleep", "Paralysis", "Freeze"] : [])) };
    sim.party = members.map((m, i) => {
      Object.assign(sim.stackDef, m.sheet.stacks || {});
      Object.assign(sim.stateDef, m.sheet.states || {});
      const eqStats = P.equipFor(m.gear || [], { atk: "베기" }, {}).stats;
      const stats = { ...m.stats };
      for (const [k, v] of Object.entries(eqStats)) stats[k] = (stats[k] || 0) + v;
      const type = ATK_OF[m.weaponType] || "베기";
      return { ...m, slot: i, stats, mp: stats.mp || 0, buffs: new Map(), stacks: {}, states: {}, statuses: {}, used: {}, usedTurn: {}, onceDone: new Set(),
        basic: { name: "일반 공격", kind: "active", mp: 0, steps: [{ do: "attack", type, target: "one", hits: 1, mult: 100 }] } };
    });
    let total = 0;
    const perTurn = [], byMember = Object.fromEntries(sim.party.map(m => [m.id, 0])), choices = Object.fromEntries(sim.party.map(m => [m.id, []]));
    const fire = (a, on) => {
      let d = 0;
      for (const sk of a.sheet.skills) if (sk.kind === "trigger" && sk.on === on && check(sk.need, sim, a, { skill: sk.name })) {
        const r = runSteps(sim, a, sk, {});
        d += r.dmg;
        if (r.attacked && on !== "counter" && on !== "attacked") for (const s of sk.steps) if (s.do === "attack") consumeMoves(a, s);
      }
      byMember[a.id] += d; total += d;
      return d;
    };
    const speed = u => (u.stats ? u.stats.spd : u.data.spd || 0) * (1 + (u.stats ? net(u, ["속도"], sim) : 0)) * (0.9 + 0.2 * rand());

    for (const a of sim.party) fire(a, "battle_start");                         // 1. 전투 시작 — 왼쪽부터
    for (sim.turn = 1; sim.turn <= turns; sim.turn++) {
      const before = total;
      sim.attacked = new Set();
      for (const a of sim.party) fire(a, "turn_start");                         // 3. 턴 시작 — 왼쪽부터
      // 5~7. 행동 — 계층(선제 · 보통 · 후공) → 속도(±10%) 순
      const tierOf = (a, sk) => {
        let t = TIER[sk.tier || "normal"];
        for (const n of Object.keys(a.states)) {
          const f = (sim.stateDef[n] || {}).tier;                              // First Strike: 후공 아닌 것 → 선제 / Delay: 선제 아닌 것 → 후공
          if (f === "pre" && t !== 2) t = 0;
          if (f === "delayed" && t !== 0) t = 2;
        }
        return t;
      };
      const acts = sim.party.map(a => { const sk = choose(sim, a); choices[a.id].push(sk.name); return { a, sk, tier: tierOf(a, sk), spd: speed(a) }; });
      const stunned = Object.keys(sim.enemy.statuses).some(s => /^(Stun|Sleep|Paralysis|Freeze)$/.test(s));
      if (!stunned && opt.enemyActs !== false) acts.push({ enemy: true, tier: 1, spd: speed(sim.enemy) });
      acts.sort((x, y) => x.tier - y.tier || y.spd - x.spd);
      sim.order.push({ t: sim.turn, order: acts.map(x => (x.enemy ? "적" : `${x.a.name}:${x.sk.name}`) + `(${Math.round(x.spd)})`) });
      for (const x of acts) {
        if (x.enemy) {                                                           // 적: 무작위 아군 1명 공격(피해 계산 없음)
          const tgt = sim.party[Math.floor(rand() * sim.party.length)];
          sim.attacked.add(tgt.id);
          for (const [n, s] of Object.entries(tgt.states)) if (((sim.stateDef[n] || {}).ends || []).includes("attacked")) delete tgt.states[n];
          fire(tgt, "attacked");
          for (const a of sim.party) fire(a, "ally_attacked");
          continue;
        }
        const { a, sk } = x;
        a.mp -= sk.mp || 0;
        const r = runSteps(sim, a, sk, {});
        a.used[sk.name] = (a.used[sk.name] || 0) + 1;
        a.usedTurn[sk.name] = sim.turn;
        byMember[a.id] += r.dmg; total += r.dmg;
        if (r.attacked) for (const s of sk.steps) if (s.do === "attack" && stepOk(s, sim, a, { skill: sk.name })) { consumeMoves(a, s); break; }
        for (const t of a.sheet.skills) if (t.kind === "trigger" && t.on === "on_use:" + sk.name) { const q = runSteps(sim, a, t, {}); byMember[a.id] += q.dmg; total += q.dmg; }
      }
      // 9. 턴 종료 행동 — 속도순
      for (const a of [...sim.party].sort((p, q) => speed(q) - speed(p))) fire(a, "turn_end");
      // 11. 지속 감소 · 만료, 각성 존 · 상태
      for (const u of [...sim.party, sim.enemy]) {
        for (const [k, b] of u.buffs) if (b.left !== Infinity && --b.left < 0) u.buffs.delete(k);
        for (const [n, s] of Object.entries(u.states)) { if (s.left !== Infinity && --s.left < 0) delete u.states[n]; else s.age++; }
        for (const n of Object.keys(u.statuses)) if (u.statuses[n] !== Infinity && --u.statuses[n] < 0) delete u.statuses[n];
      }
      if (sim.zone && sim.zone.awakened && --sim.zone.left < 0) sim.zone = null;  // 각성 만료 — 원래 존도 사라짐
      // 14. 축적 감소(턴 종료마다 N)
      for (const a of sim.party) for (const [n, k] of Object.entries(a.stacks)) {
        const dec = ((sim.stackDef[n] || {}).decay || {}).turn_end;
        if (dec) { a.stacks[n] = Math.max(0, k - dec); if (!a.stacks[n]) delete a.stacks[n]; }
      }
      perTurn.push(total - before);
    }
    return { total, perTurn, byMember, choices, log: sim.log, order: sim.order };
  }

  // 몬테카를로 — 속도 난수 · 적 표적 · 확률 조건을 시드만 바꿔 n 회
  function monteCarlo(members, enemy, opt = {}, n = 200) {
    const totals = [];
    let last;
    for (let i = 0; i < n; i++) { last = simulate(members, enemy, { ...opt, seed: (opt.seed || 1) * 7919 + i }); totals.push(last.total); }
    totals.sort((a, b) => a - b);
    const mean = totals.reduce((s, x) => s + x, 0) / n;
    const q = p => totals[Math.min(n - 1, Math.floor(p * n))];
    return { mean, p10: q(0.1), p50: q(0.5), p90: q(0.9), sample: last };
  }

  function plan(members, enemy, opt = {}, conf = {}) {
    const turns = opt.turns || 5, seeds = conf.seeds || 8, passes = conf.passes || 4;
    const score = ms => { let t = 0; for (let i = 0; i < seeds; i++) t += simulate(ms, enemy, { ...opt, seed: 1000 + i }).total; return t / seeds; };
    const base = simulate(members, enemy, { ...opt, seed: 1000 });
    let rot = members.map(m => base.choices[m.id].slice(0, turns));
    const withRot = r => members.map((m, i) => ({ ...m, rotation: r[i] }));
    const auto = score(members);
    let best = score(withRot(rot)), evals = 2;
    for (let pass = 0; pass < passes; pass++) {
      let moved = false;
      for (let t = 0; t < turns; t++) for (let i = 0; i < members.length; i++) {
        const names = [...new Set([...members[i].sheet.skills.filter(s => s.kind === "active").map(s => s.name), "일반 공격"])];
        for (const nm of names) {
          if (nm === rot[i][t]) continue;
          const r2 = rot.map(x => [...x]); r2[i][t] = nm;
          const v = score(withRot(r2)); evals++;
          if (v > best * (1 + 1e-9)) { best = v; rot = r2; moved = true; }
        }
      }
      if (!moved) break;
    }
    // 실제로 실행된 선택(계획한 스킬을 못 쓰면 자동으로 바뀐다)
    const run = simulate(withRot(rot), enemy, { ...opt, seed: 1000 });
    return { rotation: members.map((m, i) => ({ id: m.id, plan: rot[i], ran: run.choices[m.id] })), auto, best, evals, run };
  }

  const api = { simulate, monteCarlo, plan, damageOf, net, durOf, check };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AETurn = api;
})(typeof window !== "undefined" ? window : globalThis);
