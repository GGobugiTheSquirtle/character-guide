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

  // 대미지에 닿을 수 있는 장비만 — 방어구는 효과(스탯 · 대미지 · 크리)가 있는 것, 효과 없는 그라스타는 같은 스탯 묶음에서 하나만
  function damagePools(db, cc, traits) {
    const touches = it => (it.fx || []).some(f => f.k !== "etc" && f.k !== "res") || (it.calc || []).some(f => f.k !== "res")
      || DMG_STATS.some(k => (it.stats || {})[k]);
    const seen = new Set(), grasta = [];
    for (const g of db.grasta) {
      if (g.type === "VC" || !canGrasta(g, traits) || !touches(g)) continue;
      if (!(g.calc || []).some(f => f.k !== "res")) {
        const key = DMG_STATS.map(k => (g.stats || {})[k] || 0).join(",");
        if (seen.has(key)) continue;
        seen.add(key);
      }
      grasta.push(g);
    }
    return {
      weapons: db.weapons.filter(w => w.type === cc.weapon),
      armor: db.armor.filter(touches),
      grasta,
      badges: db.badges.filter(b => Object.keys(b.stats || {}).length || (b.calc || []).length),
    };
  }

  // ── 장비 ─────────────────────────────────────────────
  // m = 계산 멤버(c · fx · stats · attack · weapon …), members = m 을 포함한 파티(혼자면 [m])
  // conf = { grastaSlots: 4, badgeSlots: 2, dupGrasta: true, counts: {이름: 보유 수} | null }
  //   counts 가 있으면 그 수까지만(보유 모드), 없으면 그라스타는 dupGrasta 로 중복 허용, 고유 배지는 1개(무작위 배지는 중복 가능)
  // 반환 { gear: {weapon, armor, grasta[], badges[]}, value, start, evals }
  // 파티 안의 같은 멤버(id)를 w 로 바꾼 명단 — 없으면 끝에 넣는다
  const swapIn = (members, w) => members.some(x => x.c.id === w.c.id) ? members.map(x => (x.c.id === w.c.id ? w : x)) : [...members, w];

  function gearOptimize(m, members, opt, pools, conf = {}) {
    const gs = conf.grastaSlots ?? 4, bs = conf.badgeSlots ?? 2;
    const w = { ...m };
    const team = swapIn(members, w);
    const limit = (it, kind) => {
      if (conf.counts) return conf.counts[it.name] || 0;
      if (kind === "g") return conf.dupGrasta === false ? 1 : Infinity;
      if (kind === "b") return it.kind === "random" ? Infinity : 1;
      return 1;
    };
    let evals = 0;
    const pre = P.prepare(team, opt);                     // 장비는 파티 버프와 무관 — 한 번만
    const score = s => {
      w.weapon = s.weapon; w.armor = s.armor;
      w.grasta = s.grasta.filter(Boolean); w.badges = s.badges.filter(Boolean);
      evals++;
      const d = P.memberDamage(w, team, opt, pre);
      return d ? d.expected : 0;
    };
    const pad = (a, n) => Array.from({ length: n }, (_, i) => (a || [])[i] || null);
    const start = score({ weapon: m.weapon || null, armor: m.armor || null, grasta: pad(m.grasta, gs), badges: pad(m.badges, bs) });
    // 탐색은 후보 안에서만 — 지금 장비가 후보(보유 목록) 밖이면 빈 칸에서 시작
    const inPool = (it, pool) => (it && pool.some(x => x.name === it.name) ? pool.find(x => x.name === it.name) : null);
    let state = { weapon: inPool(m.weapon, pools.weapons) || pools.weapons[0] || null, armor: inPool(m.armor, pools.armor),
      grasta: pad((m.grasta || []).map(g => inPool(g, pools.grasta)).filter(Boolean), gs),
      badges: pad((m.badges || []).map(b => inPool(b, pools.badges)).filter(Boolean), bs) };
    let best = score(state);
    const slots = ["weapon", "armor", ...state.grasta.map((_, i) => ["grasta", i]), ...state.badges.map((_, i) => ["badges", i])];
    for (let pass = 0; pass < 10; pass++) {
      let moved = false;
      for (const sl of slots) {
        const [key, i] = Array.isArray(sl) ? sl : [sl, -1];
        const pool = key === "weapon" ? pools.weapons : key === "armor" ? pools.armor : key === "grasta" ? pools.grasta : pools.badges;
        const kind = key === "grasta" ? "g" : key === "badges" ? "b" : "e";
        const used = it => (i < 0 ? 0 : state[key].filter((x, j) => j !== i && x === it).length);
        for (const it of [null, ...pool]) {
          if (it === null && key === "weapon" && pools.weapons.length) continue;
          if (it && used(it) >= limit(it, kind)) continue;
          const s2 = { ...state, grasta: [...state.grasta], badges: [...state.badges] };
          if (i < 0) s2[key] = it; else s2[key][i] = it;
          const v = score(s2);
          if (v > best * (1 + 1e-9)) { best = v; state = s2; moved = true; }
        }
      }
      if (!moved) break;
    }
    score(state);
    return { gear: { weapon: state.weapon, armor: state.armor, grasta: state.grasta.filter(Boolean), badges: state.badges.filter(Boolean) },
      value: best, start, evals };
  }

  // 공격까지 고르는 장비 최적화 — attacks 각각에 장비를 맞춰 보고 가장 큰 것
  function bestSetup(m, members, opt, pools, conf, attacks) {
    let best = null;
    for (const a of attacks) {
      const mm = { ...m, attack: a };
      const r = gearOptimize(mm, swapIn(members, mm), opt, pools, conf);
      if (!best || r.value > best.value) best = { ...r, attack: a };
    }
    return best;
  }

  // 고를 공격 — 기본은 MP 를 쓰는 일반 스킬(배율 > 0). MP 0 · 없음(「일반 공격 대체」 · 스택 발동 · EOT)과
  //   범위 배율의 위값은 조건부(cond)에서만 — 안 그러면 스택을 다 모은 특수기가 순위를 독식한다 (2026-10-08)
  const effMult = (a, cond) => (cond && a.multMax) || a.mult || 0;
  function attackPool(atks, cond) {
    const by = xs => xs.sort((a, b) => effMult(b, cond) - effMult(a, cond));
    const main = atks.filter(a => a.sec === "skills" && effMult(a, cond) > 0 && (cond || a.mp > 0));
    return by(main.length ? main : atks.filter(a => effMult(a, cond) > 0));
  }

  // ── 파티 ─────────────────────────────────────────────
  // 후보 = 계산 멤버(c · cc · fx · stats · weapon · atks(고를 공격) · zones), 전원 전방
  // 점수 = 존 후보(없음 + 파티원이 전개하는 존)마다 각 멤버의 가장 센 공격 기대값 → 합계(sum) 또는 최댓값(carry)
  function bestAttack(m, team, opt, pre) {
    let best = null;
    for (const a of m.atks) {
      m.attack = a;
      const d = P.memberDamage(m, team, opt, pre);
      if (d && (!best || d.expected > best.expected)) best = { attack: a, expected: d.expected };
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

  const api = { baseId, canGrasta, damagePools, attackPool, gearOptimize, bestSetup, bestAttack, scoreParty, partySearch };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AEOpt = api;
})(typeof window !== "undefined" ? window : globalThis);
