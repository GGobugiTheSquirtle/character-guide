// 장비 · 파티 최적화 (2026-10-08) — 정적 추정(party_calc 「다 깐 뒤 스킬 1회」) 위에서 최고값을 찾는다
//   장비: 좌표 하강(한 칸씩 전 후보를 바꿔 보며 오를 때까지 반복) — 효과가 대부분 같은 그룹 가산이라 거의 분리 가능하다
//   파티: 탐욕 채우기 + 한 명씩 교체 등반, 시작점 여럿(단독 딜 상위). 같은 캐릭터의 다른 스타일(_as/_es)은 한 파티에 하나만
//   브라우저(window.AEOpt) · node 공용. 테스트: _tools/character/tests/test_optimizer.cjs (축소 공간 전수 탐색과 대조)
(function (root) {
  "use strict";
  const P = root.AEParty || require("./party_calc.js");

  const baseId = id => id.replace(/_(as|es)$/, "");
  const canGrasta = (g, traits) => !(g.req && g.req.length) || g.req.some(t => (traits || []).includes(t));
  const DMG_STATS = ["pwr", "int", "spd", "lck", "mp"];
  // 방어구 종류는 무기 종류로 정해진다(위키 Cargo Characters.AccessoryType 388명 전원, 2026-10-17 — 전에는 안 걸러 못 끼는 방어구를 추천할 수 있었다)
  const ACC = { 지팡이: "Ring", 활: "Ring", 도: "Ring", 검: "Bangle", 창: "Bangle", 망치: "Bangle", 권갑: "Necklace", 도끼: "Necklace" };

  // 대미지에 닿을 수 있는 장비만 — 방어구는 효과(스탯 · 대미지 · 크리)가 있는 것, 효과 없는 그라스타는 같은 스탯 묶음에서 하나만
  // 특수 광석 — 엔진이 읽는 계산 키가 있고 값이 확정된 것만(2026-10-14 개인 최강 세팅)
  const ENGINE_KEYS = new Set(["stat", "dmg", "punish", "skillfx", "weak", "crit_rate", "crit_dmg", "growth", "aim", "mpatk", "overthrow", "zonedmg", "wins", "lsally", "seal", "enemies", "fallen", "tstat"]);
  const oreUseful = o => o.kind === "special" && (o.calc || []).length && o.calc.every(f => ENGINE_KEYS.has(f.k) && !f.rank);
  // 글래스터 + 특수 광석 한 덩어리 — 글래스터 하나엔 연성 하나라 잠재 광석 강화(calc_ore)는 빠진다(위키 Grasta Enhancements)
  //   광석에서 온 효과는 ore:true — 글래스터 자체 조건이 맞을 때만 켠다(party_calc.equipFor 의 광석 조건 연동 가정)
  const withOre = (g, o) => ({ ...g, name: `${g.name} + ${o.name}`, calc: [...(g.calc || []), ...o.calc.map(f => ({ ...f, ore: true }))], calc_ore: undefined, base: g.name, ore: o.name,
    oreLimit: o.limit ?? Infinity });
  // 특수 칸(위키 Grasta · Valor Chant Grastas, 2026-10-14) — 일반 칸(아래 3 + 위 1, 명암 200)과 별개인 1칸. VC · Special 형만 들어간다.
  //   VC 는 그 캐릭터(다른 스타일 포함)의 것만 · Extreme = True VC + Fated Star Proof → HP 900 · MP 75 · 나머지 스탯 ⌊LS/25 + 15⌋(LS 255 = 25)
  //   얼터도 같은 캐릭터 — 「Isuka (Alter) (Another Style)」 = Isuka(hinaden 실전: 얼터 6명이 본 캐릭터 증표, 11-08 — 전에는 얼터 전원이 자기 증표를 후보에서 잃었다)
  const baseChar = n => (n || "").replace(/\s*\((Another|Extra) Style\)$/, "").replace(/\s+(AS|ES)$/, "").replace(/\s*\(Alter\)/, "");
  const LS = 255, EX = Math.floor(LS / 25 + 15);
  function specialPool(db, cc, traits) {
    const who = baseChar(cc.page);
    const vc = db.grasta.filter(g => g.type === "VC" && who && baseChar(g.connection) === who);
    const ex = vc.map(g => ({ ...g, name: `${g.name} (Extreme)`, stats: { hp: 900, mp: 75, ...Object.fromEntries(["pwr", "int", "spd", "end", "spr", "lck"].map(k => [k, EX])) }, limit: 1 }));
    return [...db.grasta.filter(g => g.type === "Special" && canGrasta(g, traits)), ...vc, ...ex];
  }
  function damagePools(db, cc, traits, conf = {}) {
    const touches = it => (it.fx || []).some(f => f.k !== "etc" && f.k !== "res") || [...(it.calc || []), ...(it.calc_ore || [])].some(f => f.k !== "res")
      || DMG_STATS.some(k => (it.stats || {})[k]);
    const seen = new Set(), grasta = [];
    for (const g of db.grasta) {
      if (g.type === "VC" || g.type === "Special" || !canGrasta(g, traits) || !touches(g)) continue;
      if (![...(g.calc || []), ...(g.calc_ore || [])].some(f => f.k !== "res")) {
        const key = DMG_STATS.map(k => (g.stats || {})[k] || 0).join(",");
        if (seen.has(key)) continue;
        seen.add(key);
      }
      grasta.push(g);
    }
    // 광석 조합(conf.ores !== false 이고 db.ores 가 있을 때) — 글래스터마다 「잠재 연성(기본)」 + 「특수 광석 1개」 변형
    if (db.ores && conf.ores !== false) {
      const ores = db.ores.filter(oreUseful);
      for (const g of [...grasta]) for (const o of ores) grasta.push(withOre(g, o));
    }
    return {
      weapons: db.weapons.filter(w => w.type === cc.weapon),
      armor: db.armor.filter(a => touches(a) && (!ACC[cc.weapon] || a.type === ACC[cc.weapon])),
      grasta,
      badges: db.badges.filter(b => Object.keys(b.stats || {}).length || (b.calc || []).length),
      ...(conf.special ? { special: specialPool(db, cc, traits) } : {}),
    };
  }

  // 그라스타가 부여하는 공격 스킬(grant.kind attack, 2026-10-15 S7) — 이 캐릭터가 낄 수 있는 것만, 스킬 이름별 하나. via = 그 그라스타(lockGrasta 로 고정)
  function grantAttacks(pools) {
    const seen = new Map();
    for (const g of pools.grasta || []) {
      const a = g.grant && g.grant.kind === "attack" && g.grant.attack;
      if (a && !g.ore && !seen.has(a.skill)) seen.set(a.skill, { ...a, via: g });
    }
    return [...seen.values()];
  }

  // ── 장비 ─────────────────────────────────────────────
  // m = 계산 멤버(c · fx · stats · attack · weapon …), members = m 을 포함한 파티(혼자면 [m])
  // conf = { grastaSlots: 4, badgeSlots: 2, specialSlots: 1(pools.special 이 있을 때), dupGrasta: true, counts: {이름: 보유 수} | null }
  //   counts 가 있으면 그 수까지만(보유 모드), 없으면 그라스타는 dupGrasta 로 중복 허용, 고유 배지는 1개(무작위 배지는 중복 가능)
  //   scoreFn(team) 이 있으면 해당 멤버를 후보 장비로 바꾼 전체 파티를 같은 목적 함수로 평가한다.
  // 반환 { gear: {weapon, armor, grasta[], badges[]}, value, start, evals }
  // 파티 안의 같은 멤버(id)를 w 로 바꾼 명단 — 없으면 끝에 넣는다
  // 일반 칸 그라스타 — 화면 멤버(calcMember)는 대미지 계산용 grasta 에 특수 칸(special)까지 넣어 둔다
  const normalOf = m => (m.grasta || []).filter(g => !(m.special || []).includes(g));
  const swapIn = (members, w) => members.some(x => x.c.id === w.c.id) ? members.map(x => (x.c.id === w.c.id ? w : x)) : [...members, w];
  const gearKey = (it, kind) => { const name = kind === "g" ? it.base || it.name : it.name; return name ? kind + ":" + name : null; };
  const gearEntries = s => [[s.weapon, "e"], [s.armor, "e"], ...(s.grasta || []).map(g => [g, "g"]), ...(s.special || []).map(g => [g, "g"]), ...(s.badges || []).map(b => [b, "b"])].filter(([it]) => it);
  const gearLimit = (it, kind, conf) => conf.counts ? conf.counts[kind === "g" ? it.base || it.name : it.name] || 0
    : kind === "g" ? conf.dupGrasta === false ? 1 : it.limit ?? Infinity : kind === "b" ? it.kind === "random" ? Infinity : 1 : 1;
  function quantityError(state, conf) {
    for (const [key, n] of [["grasta", conf.grastaSlots ?? 4], ["badges", conf.badgeSlots ?? 2], ["special", conf.specialSlots ?? 1]])
      if ((state[key] || []).filter(Boolean).length > n) return "장착 칸";
    const used = {}, add = k => (used[k] = (used[k] || 0) + 1) + ((conf.taken || {})[k] || 0);
    for (const [it, kind] of gearEntries(state)) {
      const key = gearKey(it, kind);
      if ((key ? add(key) : 1) > gearLimit(it, kind, conf)) return it.name || "이름 없는 장비";
      if (it.ore && add("o:" + it.ore) > (it.oreLimit ?? Infinity)) return it.ore;
    }
    return null;
  }
  const locksOf = (m, conf) => ({ weapon: m.lockWeapon || null, armor: m.lockArmor || null,
    grasta: m.lockGrasta || conf.lockGrasta || [], badges: m.lockBadges || conf.lockBadges || [], special: [] });
  const memberGear = m => ({ weapon: m.weapon, armor: m.armor, grasta: normalOf(m), special: m.special || [], badges: m.badges || [] });
  function countGear(out, state, delta = 1) {
    for (const [it, kind] of gearEntries(state)) {
      const k = gearKey(it, kind); if (k) out[k] = (out[k] || 0) + delta;
      if (it.ore) out["o:" + it.ore] = (out["o:" + it.ore] || 0) + delta;
    }
    return out;
  }
  function fitsPools(state, pools, locks) {
    const has = (key, it) => !it || (pools[key === "weapon" ? "weapons" : key] || []).some(x => x.name === it.name)
      || (Array.isArray(locks[key]) ? locks[key] : [locks[key]]).some(x => x && x.name === it.name);
    const hasLocks = key => { const need = {}; for (const it of locks[key] || []) need[it.name] = (need[it.name] || 0) + 1;
      return Object.entries(need).every(([name, n]) => (state[key] || []).filter(x => x && x.name === name).length >= n); };
    return ["weapon", "armor"].every(k => has(k, state[k]) && (!locks[k] || (state[k] && state[k].name === locks[k].name)))
      && ["grasta", "badges", "special"].every(k => (state[k] || []).every(it => has(k, it))
        && hasLocks(k));
  }
  // 입력을 바꾸지 않는 최종 검사. 후보 풀은 선택 사항이며 명시 잠금은 후보 밖이어도 수량을 지키면 유지한다.
  function validateTeam(team, conf = {}, poolsOf) {
    const all = { ...(conf.taken || {}) };
    team.forEach(m => countGear(all, memberGear(m)));
    for (const m of team) {
      const state = memberGear(m), taken = countGear({ ...all }, state, -1);
      const bad = quantityError(state, { ...conf, taken });
      if (bad) throw new RangeError(`${m.c.id}: ${bad}의 보유 수·획득 제한을 초과합니다.`);
      const pools = poolsOf ? poolsOf(m) : { weapons: [state.weapon].filter(Boolean), armor: [state.armor].filter(Boolean), grasta: state.grasta, badges: state.badges, special: state.special };
      if (!fitsPools(state, pools, locksOf(m, conf))) throw new RangeError(`${m.c.id}: 장착 후보 또는 고정 장비 조건과 맞지 않습니다.`);
    }
    return true;
  }
  function initialGear(m, pools, conf) {
    const locks = locksOf(m, conf), gs = conf.grastaSlots ?? 4, bs = conf.badgeSlots ?? 2, ss = pools.special ? conf.specialSlots ?? 1 : 0;
    if (locks.grasta.length > gs || locks.badges.length > bs) throw new Error("고정 장비 수가 장착 칸보다 많습니다.");
    const s = { weapon: null, armor: null, grasta: Array(gs).fill(null), badges: Array(bs).fill(null), special: Array(ss).fill(null) };
    const inPool = (it, pool) => it && (pool || []).find(x => x.name === it.name);
    const put = (key, i, item, required = false) => {
      // 스킬을 부여하는 고정 장비는 대미지 후보에서 빠질 수 있다. 잠금은 유지하되 수량은 아래에서 검사한다.
      const it = inPool(item, pools[key === "weapon" ? "weapons" : key]) || (required ? item : null);
      if (!it) return false;
      if (i < 0) s[key] = it; else s[key][i] = it;
      const bad = quantityError(s, conf);
      if (bad) {
        if (i < 0) s[key] = null; else s[key][i] = null;
        if (required) throw new Error(`고정 장비 ${bad}: 보유 수·획득 제한 또는 다른 파티원 사용 수와 충돌합니다.`);
        return false;
      }
      return true;
    };
    for (const key of ["weapon", "armor"]) if (locks[key]) put(key, -1, locks[key], true);
    for (const key of ["grasta", "badges"]) locks[key].forEach((it, i) => put(key, i, it, true));
    for (const key of ["weapon", "armor"]) if (!locks[key] && m[key]) put(key, -1, m[key]);
    for (const [key, source] of [["grasta", normalOf(m)], ["badges", m.badges || []], ["special", m.special || []]]) {
      for (const it of source.filter(Boolean)) {
        if ((locks[key] || []).some(g => g.name === it.name)) continue;
        const i = s[key].findIndex(x => !x); if (i < 0) break;
        put(key, i, it);
      }
    }
    if (!s.weapon) for (const it of pools.weapons || []) if (put("weapon", -1, it)) break;
    return s;
  }

  function gearOptimize(m, members, opt, pools, conf = {}) {
    const lock = m.lockGrasta || conf.lockGrasta || [];                    // 고정 그라스타(부여 스킬을 쓰려면 그 그라스타가 칸에 있어야 한다) — 앞 칸부터, 탐색 제외
    const lockB = m.lockBadges || conf.lockBadges || [];                   // 고정 배지(배지 습득 스킬, 2026-11-12) — 같은 방식
    const w = { ...m };
    const team = swapIn(members, w);
    // 획득 가능 수(2026-10-14 SV — 1회성 보상 글래스터 · 광석을 여러 개 끼우던 것): 글래스터 = 기본 이름별 limit(위키 획득처, null = 반복 획득),
    //   특수 광석 = 광석별 oreLimit. 보유 모드(conf.counts)는 보유 수
    // 파티 공동(2026-10-15): conf.taken = 다른 파티원이 이미 쓴 수({"g:기본 이름" · "o:광석" · "e:무기/방어구" · "b:배지": 수}),
    //   conf.others = [{m, w}] 이 멤버의 그라스타(공유)가 바꾸는 파티원 대미지 × 가중치, conf.selfWeight = 자기 대미지 가중치(기본 1)
    let evals = 0;
    const pre = conf.scoreFn ? null : P.prepare(team, opt);                     // 장비는 파티 버프와 무관 — 한 번만
    const score = s => {
      w.weapon = s.weapon; w.armor = s.armor;
      w.special = s.special.filter(Boolean); w.gear = { grasta: s.grasta.filter(Boolean), special: w.special };
      w.grasta = [...w.gear.grasta, ...w.special]; w.badges = s.badges.filter(Boolean);
      evals++;
      if (conf.scoreFn) return conf.scoreFn(team);
      const d = P.memberDamage(w, team, opt, pre);
      const own = (conf.selfWeight ?? 1) * (d ? d.perUse : 0);
      if (!conf.others || !conf.others.length) return own;
      const sig = w.grasta.filter(g => g.share && !g.ore).map(g => g.name).sort().join("|");   // 남에게 닿는 건 공유 그라스타뿐 — 그 집합이 같으면 다시 안 잰다
      if (sig !== othersSig) { othersSig = sig; othersV = conf.others.reduce((t, o) => t + o.w * ((P.memberDamage(o.m, team, opt, pre) || {}).perUse || 0), 0); }
      return own + othersV;
    };
    let othersSig = null, othersV = 0;
    // 초기값도 후보·보유 수·획득 제한을 만족시킨 뒤 탐색한다. 잠금 충돌은 초기화에서 오류로 반환한다.
    let state = initialGear(m, pools, conf);
    const start = score(state);
    let best = start;
    const slots = [...(m.lockWeapon ? [] : ["weapon"]), ...(m.lockArmor ? [] : ["armor"]), ...state.grasta.map((_, i) => ["grasta", i]).filter(([, i]) => i >= lock.length), ...state.badges.map((_, i) => ["badges", i]).filter(([, i]) => i >= lockB.length), ...state.special.map((_, i) => ["special", i])];
    for (let pass = 0; pass < 10; pass++) {
      let moved = false;
      for (const sl of slots) {
        const [key, i] = Array.isArray(sl) ? sl : [sl, -1];
        const pool = key === "weapon" ? pools.weapons : key === "armor" ? pools.armor : key === "grasta" ? pools.grasta : key === "special" ? pools.special : pools.badges;
        for (const it of [null, ...pool]) {
          if (it === null && key === "weapon" && pools.weapons.length) continue;
          const s2 = { ...state, grasta: [...state.grasta], badges: [...state.badges], special: [...state.special] };
          if (i < 0) s2[key] = it; else s2[key][i] = it;
          if (quantityError(s2, conf)) continue;
          const v = score(s2);
          if (v > best * (1 + 1e-9)) { best = v; state = s2; moved = true; }
        }
      }
      if (!moved) break;
    }
    score(state);
    return { gear: { weapon: state.weapon, armor: state.armor, grasta: state.grasta.filter(Boolean), badges: state.badges.filter(Boolean), special: state.special.filter(Boolean) },
      value: best, start, evals };
  }

  // 파티 공동 장비 최적화(2026-10-15) — 멤버마다 gearOptimize 를 돌리되 ① 다른 멤버가 쓴 장비는 수량에서 빼고(1개뿐인 그라스타 · 무기 · 고유 배지)
  //   ② 내 그라스타가 공유로 올리는 파티원 대미지까지 목표에 넣는다. 멤버를 돌아가며 반복(좌표 하강), 목표가 안 오르면 멈춤.
  //   conf = gearOptimize conf + { objective: 'sum'|'carry', carry: id, passes: 3 }, poolsOf(member) → 후보
  //   carry 면 그 멤버 대미지가 목표(다른 멤버는 1e-3 — 남는 장비로 무난하게), 그 멤버를 먼저 채운다
  function partyGear(members, opt, poolsOf, conf = {}) {
    const team = members.map(m => ({ ...m, gear: { grasta: normalOf(m), special: m.special || [] } }));
    const fullPools = new Map(team.map(m => [m.c.id, poolsOf(m)]));
    // conf.scale = {id: 배율}(11-08) — 정적 식 값을 고점 장면 몫에 맞추는 멤버별 배율(build.optimizePeak). 정적 식은 자원 · 단계로 커지는 공격을 모른다
    //   (세스타 AS 변화한 일반 공격: 정적 217만 vs 고점 86억) → 그 멤버 비중이 0 이 되어 공유 그라스타가 남에게만 쏠렸다
    const wt = x => (conf.objective === "carry" ? (x.c.id === conf.carry ? 1 : 1e-3) : 1) * ((conf.scale || {})[x.c.id] ?? 1);
    const order = conf.objective === "carry" ? [...team].sort((a, b) => wt(b) - wt(a)) : team;
    const usage = except => {
      const t = { ...(conf.taken || {}) };
      for (const x of team) if (x !== except) countGear(t, memberGear(x));
      return t;
    };
    const repaired = team.some(x => quantityError(memberGear(x), { ...conf, taken: usage(x) }) || !fitsPools(memberGear(x), fullPools.get(x.c.id), locksOf(x, conf)));
    // 나중 멤버의 고정 장비를 먼저 예약해 초기 중복을 고칠 때 잠금을 빼앗지 않는다.
    const reserved = {}, allocated = { ...(conf.taken || {}) };
    team.forEach(x => countGear(reserved, locksOf(x, conf)));
    for (const x of team) {
      countGear(reserved, locksOf(x, conf), -1);
      const taken = { ...allocated }; for (const [k, v] of Object.entries(reserved)) taken[k] = (taken[k] || 0) + v;
      const s = initialGear(x, fullPools.get(x.c.id), { ...conf, taken });
      Object.assign(x, { weapon: s.weapon, armor: s.armor, badges: s.badges.filter(Boolean), special: s.special.filter(Boolean),
        gear: { grasta: s.grasta.filter(Boolean), special: s.special.filter(Boolean) }, grasta: [...s.grasta, ...s.special].filter(Boolean) });
      countGear(allocated, s);
    }
    const total = () => { if (conf.scoreFn) return conf.scoreFn(team); const pre = P.prepare(team, opt); return team.reduce((s, x) => s + wt(x) * ((P.memberDamage(x, team, opt, pre) || {}).perUse || 0), 0); };
    let evals = 0, best = -Infinity;
    const hist = [];
    // 그라스타 가지치기(conf.pruneGrasta, 기본 80) — 광석 조합까지 ~5,300개라 멤버마다 「혼자 꼈을 때 1회 사용 대미지」 상위 N 만 남긴다.
    //   공유 그라스타(남에게 주는 몫은 이 값에 안 잡힌다)는 항상 남김. 효과 대부분이 같은 그룹 가산이라 한 개 이득 순위 ≈ 조합 순위
    const N = conf.pruneGrasta ?? 80, pruned = new Map();
    const poolsFor = x => {
      if (pruned.has(x.c.id)) return pruned.get(x.c.id);
      const p = fullPools.get(x.c.id);
      let out = p;
      if (N && p.grasta.length > N) {
        const pre = P.prepare(team, opt), solo = { ...x, grasta: [] };
        const t = swapIn(team, solo);
        const val = g => { solo.grasta = [g]; evals++; return (P.memberDamage(solo, t, opt, pre) || {}).perUse || 0; };
        const ranked = p.grasta.map(g => [g, val(g)]).sort((a, b) => b[1] - a[1]).map(([g]) => g);
        const keep = new Set(ranked.slice(0, N));
        for (const g of p.grasta) if (g.share && !g.ore) keep.add(g);
        out = { ...p, grasta: p.grasta.filter(g => keep.has(g)) };
      }
      pruned.set(x.c.id, out);
      return out;
    };
    // 마지막 다듬기(conf.polish, 기본 켬) — 가지치기 목록이 혼자 기준이라 존 · 공유 시너지로만 크는 그라스타를 놓친다(4인 실측 −5.7%).
    //   가지치기 반복이 수렴한 뒤 전체 후보로 한 바퀴 더 — 시작점이 좋아 전체 후보 반복보다 빠르다
    const polish = N && conf.polish !== false;
    for (let pass = 0, full = false; pass < (conf.passes ?? 3) + (polish ? 1 : 0); pass++) {
      for (const x of order) {
        const others = team.filter(o => o !== x).map(o => ({ m: o, w: wt(o) }));
        // 지금 낀 그라스타는 후보에 꼭 둔다 — 맞바꾸기로 받은 것이 이 멤버의 가지치기 목록 밖이면 버려져 목표가 내려갔다(2026-10-15)
        const pf = full ? fullPools.get(x.c.id) : poolsFor(x), extra = x.gear.grasta.filter(g => g && !pf.grasta.includes(g));
        const r = gearOptimize({ ...x, grasta: x.gear.grasta, special: x.gear.special }, team, opt, extra.length ? { ...pf, grasta: [...pf.grasta, ...extra] } : pf,
          { ...conf, taken: usage(x), others, selfWeight: wt(x), lockGrasta: x.lockGrasta || conf.lockGrasta, lockBadges: x.lockBadges || conf.lockBadges });   // 멤버별 고정(파티 빌드의 부여 스킬 그라스타, 10-17)
        evals += r.evals;
        Object.assign(x, { weapon: r.gear.weapon, armor: r.gear.armor, badges: r.gear.badges, special: r.gear.special || [], gear: { grasta: r.gear.grasta, special: r.gear.special || [] },
          grasta: [...r.gear.grasta, ...(r.gear.special || [])] });
      }
      let v = total();
      // 맞바꾸기 — 먼저 고른 멤버가 1개뿐인 장비를 쥐고 있으면 좌표 하강은 못 빠져나온다(국소 최적). 두 멤버의 같은 종류 칸을 서로 바꿔 본다
      for (const x of team) for (const y of team) {
        if (x === y || team.indexOf(x) > team.indexOf(y)) continue;
        const free = (z, g) => !(z.lockGrasta || []).includes(g);                     // 고정 그라스타는 맞바꾸지 않는다
        const tries = [["weapon"], ["armor"], ...x.gear.grasta.flatMap((g, i) => (free(x, g) ? y.gear.grasta.map((h, j) => (free(y, h) ? ["g", i, j] : null)).filter(Boolean) : [])),
          ...(x.badges || []).flatMap((b, i) => (!(x.lockBadges || []).includes(b) ? (y.badges || []).map((c, j) => (!(y.lockBadges || []).includes(c) ? ["b", i, j] : null)).filter(Boolean) : []))];
        for (const [k, i, j] of tries) {
          const sw = () => {
            if (k === "weapon" || k === "armor") { if ((x[k] && x[k].type) !== (y[k] && y[k].type)) return false; [x[k], y[k]] = [y[k], x[k]]; }
            else if (k === "b") [x.badges[i], y.badges[j]] = [y.badges[j], x.badges[i]];
            else { [x.gear.grasta[i], y.gear.grasta[j]] = [y.gear.grasta[j], x.gear.grasta[i]]; for (const z of [x, y]) z.grasta = [...z.gear.grasta, ...z.gear.special]; }
            return true;
          };
          const fits = () => [x, y].every(z => fitsPools(memberGear(z), fullPools.get(z.c.id), locksOf(z, conf))
            && (k !== "g" || z.gear.grasta.every(g => !g || !(g.req && g.req.length) || g.req.some(t => (z.c.traits || []).includes(t) || t === ((z.weapon && z.weapon.type) || (z.cc && z.cc.weapon))))));
          if (!sw()) continue;
          const nv = fits() ? total() : -Infinity;
          if (nv > v * (1 + 1e-9)) v = nv; else sw();
        }
      }
      hist.push(v);
      const stuck = v <= best * (1 + 1e-9);
      if (!stuck) best = v;
      if (full) { if (stuck) break; continue; }   // 다듬기에서 올랐으면 전체 후보로 계속
      if (stuck || pass === (conf.passes ?? 3) - 1) { if (!polish) break; full = true; }
    }
    const pre = P.prepare(team, opt);
    return { team, value: best, hist, evals, repaired,
      per: team.map(x => ({ id: x.c.id, attack: x.attack, expected: (P.memberDamage(x, team, opt, pre) || {}).perUse || 0, gear: { weapon: x.weapon, armor: x.armor, badges: x.badges, ...x.gear } })) };
  }

  // 공격까지 고르는 장비 최적화 — attacks 각각에 장비를 맞춰 보고 가장 큰 것
  //   members = 팀 배열, 또는 공격 → 팀 함수(외부 프리셋은 공격 속성 · 종류마다 값이 달라 공격마다 만든다, 2026-10-17)
  function bestSetup(m, members, opt, pools, conf, attacks) {
    let best = null, cand = attacks, pre = 0;
    const team = a => (typeof members === "function" ? members(a) : members);
    // 광석 조합이 있으면(그라스타 ~5,000) 공격 고르기는 광석 없는 후보로 먼저 — 상위 2개만 전체 후보로(2026-10-15 화면 연결)
    if (attacks.length > 2 && pools.grasta.some(g => g.ore)) {
      const lite = { ...pools, grasta: pools.grasta.filter(g => !g.ore) };
      cand = attacks.map(a => { const mm = { ...m, attack: a }, r = gearOptimize(mm, swapIn(team(a), mm), opt, lite, conf); pre += r.evals; return [a, r.value]; })
        .sort((x, y) => y[1] - x[1]).slice(0, 2).map(x => x[0]);
    }
    for (const a of cand) {
      const mm = { ...m, attack: a };
      const r = gearOptimize(mm, swapIn(team(a), mm), opt, pools, conf);
      if (!best || r.value > best.value) best = { ...r, attack: a };
    }
    best.evals += pre;
    return best;
  }

  // 고를 공격 — 기본은 MP 를 쓰는 일반 스킬(배율 > 0). MP 0 · 없음(「일반 공격 대체」 · 스택 발동 · EOT)과
  //   범위 배율의 위값은 조건부(cond)에서만 — 안 그러면 스택을 다 모은 특수기가 순위를 독식한다 (2026-10-08)
  const effMult = (a, cond) => (cond && a.multMax) || a.mult || 0;
  function attackPool(atks, cond) {
    const by = xs => xs.sort((a, b) => effMult(b, cond) - effMult(a, cond));
    // 발동 조건(gate — 전술 레벨 50 · 전원 카타르시스 3 · 반격 …)이 붙은 공격도 조건부에서만(2026-10-15, 라이자 20배 기술이 1위를 독식)
    const ok = a => effMult(a, cond) > 0 && (cond || !a.gate);
    const main = atks.filter(a => a.sec === "skills" && ok(a) && (cond || a.mp > 0));
    return by(main.length ? main : atks.filter(ok));
  }

  // ── 파티 ─────────────────────────────────────────────
  // 후보 = 계산 멤버(c · cc · fx · stats · weapon · atks(고를 공격) · zones), 전원 전방
  // 점수 = 존 후보(없음 + 파티원이 전개하는 존)마다 각 멤버의 가장 센 공격 기대값 → 합계(sum) 또는 최댓값(carry)
  function bestAttack(m, team, opt, pre) {
    let best = null;
    for (const a of m.atks) {
      m.attack = a;
      const d = P.memberDamage(m, team, opt, pre);
      if (d && (!best || d.perUse > best.expected)) best = { attack: a, expected: d.perUse, perHit: d.expected };   // expected = 1회 사용(1타 × 타수)
    }
    if (best) m.attack = best.attack;
    return best || { attack: null, expected: 0 };
  }
  function scoreParty(team, opt, conf) {
    let zs;
    if (conf.zoneMode === "fixed") zs = [opt.zone || null];
    else if (conf.zoneMode === "none") zs = [null];
    else {
      const names = new Set(team.flatMap(m => m.zones || []));
      zs = [null, ...(conf.zoneDb || []).filter(z => names.has(z.name))];
    }
    let best = null;
    const pre = P.prepare(team, opt);                     // 존과 무관 — 파티당 한 번
    for (const z of zs) {
      const o = { ...opt, zone: z };
      const per = team.map(m => bestAttack(m, team, o, pre));
      const vals = per.map(p => p.expected);
      const score = conf.objective === "carry" ? Math.max(...vals) : vals.reduce((s, x) => s + x, 0);
      if (!best || score > best.score) best = { score, zone: z, per: per.map((p, i) => ({ id: team[i].c.id, ...p })) };
    }
    return best;
  }

  // cands: 후보 멤버 배열, conf = { size: 4, objective: 'sum'|'carry', fixed: [id], zoneMode: 'auto'|'fixed'|'none', zoneDb,
  //   starts: 8, top: 10, tick: async (evals) => {} }  → 상위 파티 [{ids, score, zone, per}]
  async function partySearch(cands, opt, conf = {}) {
    const size = Math.min(conf.size || 4, cands.length);
    const byId = new Map(cands.map(m => [m.c.id, m]));
    const fixed = (conf.fixed || []).filter(id => byId.has(id)).slice(0, size);
    const seen = new Map();
    let evals = 0;
    const evalTeam = async ids => {
      const key = [...ids].sort().join("|");
      if (seen.has(key)) return seen.get(key);
      const r = scoreParty(ids.map(id => byId.get(id)), opt, conf);
      evals++;
      if (conf.tick && evals % 400 === 0) await conf.tick(evals);
      const out = { ids: [...ids], ...r };
      if (ids.length === size) seen.set(key, out);
      return out;
    };
    const clash = (ids, id) => ids.some(x => x === id || baseId(x) === baseId(id));
    // 단독 점수 → 시작점 · 가지치기
    const solo = new Map();
    for (const m of cands) solo.set(m.c.id, scoreParty([m], opt, conf).score);
    const top = Math.max(1, ...solo.values());
    // 파티에 주는 것이 있나 — 아군 전체 버프 또는 적 디버프(단독 딜이 낮아도 남긴다)
    const filled = x => x === true || (Array.isArray(x) ? x.length > 0 : !!x && typeof x === "object" && (x.buffs ? x.buffs.length > 0 : Object.keys(x).length > 0));
    const helps = m => { const c = P.contrib(m, opt); return c.who.length > 0 || [c.all, c.enemy].some(g => Object.entries(g).some(([k, x]) => k !== "src" && filled(x))); };
    const pool = cands.filter(m => fixed.includes(m.c.id) || solo.get(m.c.id) >= top * 0.05 || helps(m)).map(m => m.c.id);
    const starts = [...pool].filter(id => !fixed.includes(id)).sort((a, b) => solo.get(b) - solo.get(a)).slice(0, conf.starts ?? 8);
    if (!starts.length) starts.push(null);
    for (const s of starts) {
      let ids = [...fixed];
      if (s && !clash(ids, s) && ids.length < size) ids.push(s);
      while (ids.length < size) {                                   // 탐욕 채우기
        let best = null;
        for (const id of pool) {
          if (clash(ids, id)) continue;
          const r = await evalTeam([...ids, id]);
          if (!best || r.score > best.score) best = r;
        }
        if (!best) break;
        ids = best.ids;
      }
      if (ids.length < size) continue;
      let cur = await evalTeam(ids);
      for (let pass = 0; pass < 6; pass++) {                        // 교체 등반
        let moved = false;
        for (let i = 0; i < size; i++) {
          if (fixed.includes(cur.ids[i])) continue;
          for (const id of pool) {
            const rest = cur.ids.filter((_, j) => j !== i);
            if (clash(rest, id)) continue;
            const r = await evalTeam([...rest.slice(0, i), id, ...rest.slice(i)]);
            if (r.score > cur.score * (1 + 1e-9)) { cur = r; moved = true; }
          }
        }
        if (!moved) break;
      }
    }
    const list = [...seen.values()].sort((a, b) => b.score - a.score).slice(0, conf.top ?? 10);
    return { list, evals, pool: pool.length };
  }

  // 파티 탐색 2단계(2026-10-15) — ① partySearch(지금 · 기본 장비)로 상위 후보 ② 상위 gearTop 개만 partyGear 로 장비를 함께 맞추고
  //   ③ 장비 낀 점수로 다시 줄 세운다. 장비 탐색은 파티당 수십 초라 전부에 돌릴 수 없다 — 기본 장비 순위가 장비 후 순위와 크게 어긋나지 않는다는 가정
  //   conf = partySearch conf + { gearTop: 3, poolsOf(member) → 후보, gear: partyGear conf }. objective 'carry' 면 각 파티의 1위 딜러를 carry 로
  // conf.gearRunner(team, opt, gearConf) → Promise<partyGear 결과> — 화면은 워커로 보낸다(calc/opt_worker.js, 2026-10-15 화면 멈춤).
  //   없으면 이 스레드에서 partyGear(conf.poolsOf). 상위 파티들은 한꺼번에 띄운다(워커면 병렬)
  async function partySearchGeared(cands, opt, conf = {}) {
    const r1 = await partySearch(cands, opt, conf);
    const byId = new Map(cands.map(m => [m.c.id, m]));
    const run = conf.gearRunner || (async (team, o, g) => partyGear(team, o, conf.poolsOf, g));
    let evals = r1.evals, done = 0;
    const list = await Promise.all(r1.list.slice(0, conf.gearTop ?? 3).map(async p => {
      const team = p.per.map(x => ({ ...byId.get(x.id), attack: x.attack }));
      const carry = conf.objective === "carry" ? [...p.per].sort((a, b) => b.expected - a.expected)[0].id : undefined;
      const g = await run(team, { ...opt, zone: p.zone }, { ...(conf.gear || {}), objective: conf.objective === "carry" ? "carry" : "sum", carry });
      evals += g.evals;
      if (conf.tick) await conf.tick(evals, ++done);
      return { ids: p.ids, zone: p.zone, base: p.score, score: carry ? g.per.find(x => x.id === carry).expected : g.value, carry, per: g.per };
    }));
    list.sort((a, b) => b.score - a.score);
    return { list, stage1: r1.list, evals, pool: r1.pool };
  }

  // 장비 후보 — inv(보유 목록 {w, a, g, b: {이름: 수}})가 있으면 그 안에서, 특수 칸 포함. 화면 · 워커 공용
  //   광석 조합은 보유 목록에 광석 칸이 없어 전체 장비일 때만(db.ores)
  function ownedPools(db, cc, traits, inv) {
    if (!inv) return { pools: damagePools(db, cc, traits, { special: true }), counts: null };
    const sub = { weapons: db.weapons.filter(x => inv.w[x.name]), armor: db.armor.filter(x => inv.a[x.name]),
      grasta: db.grasta.filter(x => inv.g[x.name]), badges: db.badges.filter(x => inv.b[x.name]) };
    return { pools: damagePools(sub, cc, traits, { special: true }), counts: { ...inv.w, ...inv.a, ...inv.g, ...inv.b } };
  }

  const api = { baseId, canGrasta, withOre, specialPool, damagePools, ownedPools, grantAttacks, attackPool, gearOptimize, partyGear, validateTeam, partySearchGeared, bestSetup, bestAttack, scoreParty, partySearch };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AEOpt = api;
})(typeof window !== "undefined" ? window : globalThis);
