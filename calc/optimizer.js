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
  const baseChar = n => (n || "").replace(/\s*\((Another|Extra) Style\)$/, "").replace(/\s+(AS|ES)$/, "");
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
  // 반환 { gear: {weapon, armor, grasta[], badges[]}, value, start, evals }
  // 파티 안의 같은 멤버(id)를 w 로 바꾼 명단 — 없으면 끝에 넣는다
  // 일반 칸 그라스타 — 화면 멤버(calcMember)는 대미지 계산용 grasta 에 특수 칸(special)까지 넣어 둔다
  const normalOf = m => (m.grasta || []).filter(g => !(m.special || []).includes(g));
  const swapIn = (members, w) => members.some(x => x.c.id === w.c.id) ? members.map(x => (x.c.id === w.c.id ? w : x)) : [...members, w];

  function gearOptimize(m, members, opt, pools, conf = {}) {
    const gs = conf.grastaSlots ?? 4, bs = conf.badgeSlots ?? 2, ss = pools.special ? conf.specialSlots ?? 1 : 0;
    const lock = conf.lockGrasta || [];                    // 고정 그라스타(부여 스킬을 쓰려면 그 그라스타가 칸에 있어야 한다) — 앞 칸부터, 탐색 제외
    const w = { ...m };
    const team = swapIn(members, w);
    // 획득 가능 수(2026-10-14 SV — 1회성 보상 글래스터 · 광석을 여러 개 끼우던 것): 글래스터 = 기본 이름별 limit(위키 획득처, null = 반복 획득),
    //   특수 광석 = 광석별 oreLimit. 보유 모드(conf.counts)는 보유 수
    // 파티 공동(2026-10-15): conf.taken = 다른 파티원이 이미 쓴 수({"g:기본 이름" · "o:광석" · "e:무기/방어구" · "b:배지": 수}),
    //   conf.others = [{m, w}] 이 멤버의 그라스타(공유)가 바꾸는 파티원 대미지 × 가중치, conf.selfWeight = 자기 대미지 가중치(기본 1)
    const tkey = (it, kind) => (kind === "g" ? "g:" + (it.base || it.name) : kind === "b" ? "b:" + it.name : "e:" + it.name);
    const taken = (it, kind) => (conf.taken || {})[tkey(it, kind)] || 0;
    const limit = (it, kind) => {
      if (conf.counts) return conf.counts[kind === "g" ? it.base || it.name : it.name] || 0;
      if (kind === "g") return conf.dupGrasta === false ? 1 : it.limit ?? Infinity;
      if (kind === "b") return it.kind === "random" ? Infinity : 1;
      return 1;
    };
    let evals = 0;
    const pre = P.prepare(team, opt);                     // 장비는 파티 버프와 무관 — 한 번만
    const score = s => {
      w.weapon = s.weapon; w.armor = s.armor;
      w.grasta = [...s.grasta, ...(s.special || [])].filter(Boolean); w.badges = s.badges.filter(Boolean);
      evals++;
      const d = P.memberDamage(w, team, opt, pre);
      const own = (conf.selfWeight ?? 1) * (d ? d.perUse : 0);
      if (!conf.others || !conf.others.length) return own;
      const sig = w.grasta.filter(g => g.share && !g.ore).map(g => g.name).sort().join("|");   // 남에게 닿는 건 공유 그라스타뿐 — 그 집합이 같으면 다시 안 잰다
      if (sig !== othersSig) { othersSig = sig; othersV = conf.others.reduce((t, o) => t + o.w * ((P.memberDamage(o.m, team, opt, pre) || {}).perUse || 0), 0); }
      return own + othersV;
    };
    let othersSig = null, othersV = 0;
    const pad = (a, n) => Array.from({ length: n }, (_, i) => (a || [])[i] || null);
    const start = score({ weapon: m.weapon || null, armor: m.armor || null, grasta: pad(normalOf(m), gs), badges: pad(m.badges, bs), special: pad(m.special, ss) });
    // 탐색은 후보 안에서만 — 지금 장비가 후보(보유 목록) 밖이면 빈 칸에서 시작
    const inPool = (it, pool) => (it && pool.some(x => x.name === it.name) ? pool.find(x => x.name === it.name) : null);
    let state = { weapon: inPool(m.weapon, pools.weapons) || pools.weapons[0] || null, armor: inPool(m.armor, pools.armor),
      grasta: pad([...lock, ...normalOf(m).map(g => inPool(g, pools.grasta)).filter(g => g && !lock.includes(g))], gs),
      badges: pad((m.badges || []).map(b => inPool(b, pools.badges)).filter(Boolean), bs),
      special: pad((m.special || []).map(g => inPool(g, pools.special || [])).filter(Boolean), ss) };
    let best = score(state);
    const slots = ["weapon", "armor", ...state.grasta.map((_, i) => ["grasta", i]).filter(([, i]) => i >= lock.length), ...state.badges.map((_, i) => ["badges", i]), ...state.special.map((_, i) => ["special", i])];
    for (let pass = 0; pass < 10; pass++) {
      let moved = false;
      for (const sl of slots) {
        const [key, i] = Array.isArray(sl) ? sl : [sl, -1];
        const pool = key === "weapon" ? pools.weapons : key === "armor" ? pools.armor : key === "grasta" ? pools.grasta : key === "special" ? pools.special : pools.badges;
        const kind = key === "grasta" || key === "special" ? "g" : key === "badges" ? "b" : "e";
        const used = it => (i < 0 ? 0 : state[key].filter((x, j) => j !== i && x && (kind === "g" ? (x.base || x.name) === (it.base || it.name) : x === it)).length);
        const oreFull = it => key === "grasta" && it.ore && state.grasta.filter((x, j) => j !== i && x && x.ore === it.ore).length + ((conf.taken || {})["o:" + it.ore] || 0) >= (it.oreLimit ?? Infinity);
        for (const it of [null, ...pool]) {
          if (it === null && key === "weapon" && pools.weapons.length) continue;
          if (it && (used(it) + taken(it, kind) >= limit(it, kind) || oreFull(it))) continue;
          const s2 = { ...state, grasta: [...state.grasta], badges: [...state.badges], special: [...state.special] };
          if (i < 0) s2[key] = it; else s2[key][i] = it;
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
    const wt = x => (conf.objective === "carry" ? (x.c.id === conf.carry ? 1 : 1e-3) : 1);
    const order = conf.objective === "carry" ? [...team].sort((a, b) => wt(b) - wt(a)) : team;
    const usage = except => {
      const t = {}, add = k => (t[k] = (t[k] || 0) + 1);
      for (const x of team) {
        if (x === except) continue;
        if (x.weapon) add("e:" + x.weapon.name);
        if (x.armor) add("e:" + x.armor.name);
        for (const g of x.grasta || []) { add("g:" + (g.base || g.name)); if (g.ore) add("o:" + g.ore); }
        for (const b of x.badges || []) if (b.kind !== "random") add("b:" + b.name);
      }
      return t;
    };
    const total = () => { const pre = P.prepare(team, opt); return team.reduce((s, x) => s + wt(x) * ((P.memberDamage(x, team, opt, pre) || {}).perUse || 0), 0); };
    let evals = 0, best = -Infinity;
    const hist = [];
    // 그라스타 가지치기(conf.pruneGrasta, 기본 80) — 광석 조합까지 ~5,300개라 멤버마다 「혼자 꼈을 때 1회 사용 대미지」 상위 N 만 남긴다.
    //   공유 그라스타(남에게 주는 몫은 이 값에 안 잡힌다)는 항상 남김. 효과 대부분이 같은 그룹 가산이라 한 개 이득 순위 ≈ 조합 순위
    const N = conf.pruneGrasta ?? 80, pruned = new Map();
    const poolsFor = x => {
      if (pruned.has(x.c.id)) return pruned.get(x.c.id);
      const p = poolsOf(x);
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
        const pf = full ? poolsOf(x) : poolsFor(x), extra = x.gear.grasta.filter(g => g && !pf.grasta.includes(g));
        const r = gearOptimize({ ...x, grasta: x.gear.grasta, special: x.gear.special }, team, opt, extra.length ? { ...pf, grasta: [...pf.grasta, ...extra] } : pf,
          { ...conf, taken: usage(x), others, selfWeight: wt(x), lockGrasta: x.lockGrasta || conf.lockGrasta });   // 멤버별 고정(파티 빌드의 부여 스킬 그라스타, 10-17)
        evals += r.evals;
        Object.assign(x, { weapon: r.gear.weapon, armor: r.gear.armor, badges: r.gear.badges, gear: { grasta: r.gear.grasta, special: r.gear.special || [] },
          grasta: [...r.gear.grasta, ...(r.gear.special || [])] });
      }
      let v = total();
      // 맞바꾸기 — 먼저 고른 멤버가 1개뿐인 장비를 쥐고 있으면 좌표 하강은 못 빠져나온다(국소 최적). 두 멤버의 같은 종류 칸을 서로 바꿔 본다
      for (const x of team) for (const y of team) {
        if (x === y || team.indexOf(x) > team.indexOf(y)) continue;
        const free = (z, g) => !(z.lockGrasta || []).includes(g);                     // 고정 그라스타는 맞바꾸지 않는다
        const tries = [["weapon"], ["armor"], ...x.gear.grasta.flatMap((g, i) => (free(x, g) ? y.gear.grasta.map((h, j) => (free(y, h) ? ["g", i, j] : null)).filter(Boolean) : [])),
          ...(x.badges || []).flatMap((_, i) => (y.badges || []).map((_, j) => ["b", i, j]))];
        for (const [k, i, j] of tries) {
          const sw = () => {
            if (k === "weapon" || k === "armor") { if ((x[k] && x[k].type) !== (y[k] && y[k].type)) return false; [x[k], y[k]] = [y[k], x[k]]; }
            else if (k === "b") [x.badges[i], y.badges[j]] = [y.badges[j], x.badges[i]];
            else { [x.gear.grasta[i], y.gear.grasta[j]] = [y.gear.grasta[j], x.gear.grasta[i]]; for (const z of [x, y]) z.grasta = [...z.gear.grasta, ...z.gear.special]; }
            return true;
          };
          const fits = () => k !== "g" || [x, y].every(z => z.gear.grasta.every(g => !g || !(g.req && g.req.length) || g.req.some(t => (z.c.traits || []).includes(t) || t === ((z.weapon && z.weapon.type) || (z.cc && z.cc.weapon)))));
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
    return { team, value: best, hist, evals,
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
    const helps = m => { const c = P.contrib(m, opt); return [c.all, c.enemy].some(g => Object.entries(g).some(([k, x]) => k !== "src" && filled(x))); };
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

  const api = { baseId, canGrasta, withOre, specialPool, damagePools, ownedPools, grantAttacks, attackPool, gearOptimize, partyGear, partySearchGeared, bestSetup, bestAttack, scoreParty, partySearch };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AEOpt = api;
})(typeof window !== "undefined" ? window : globalThis);
