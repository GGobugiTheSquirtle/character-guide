// 파티 효과(효과 단위) → 엔진 입력 → 멤버별 1타 기대값 (2026-10-07)
//   「버프 · 디버프 · 존을 다 깐 뒤 주력기 1타」 정적 추정. 턴 · 지속 · 순서는 보지 않는다(로드맵 L4).
//   입력 효과는 skills_ko/skills_en 의 단위(k · stats · dir · value · tc · cond …), 장비는 data/calc.
//   브라우저(window.AEParty) · node 공용. 테스트: _tools/character/tests/test_party_calc.cjs
(function (root) {
  "use strict";
  const C = root.AECalc || require("./ae_calc.js");
  const ELEMS = ["불", "물", "땅", "바람", "번개", "그림자", "결정"];
  const PHYS = ["베기", "찌르기", "타격"];

  // 받는 쪽 — 아군 효과는 「아군 전체 · 자신」만(특정 아군은 누구인지 모름 → 제외), 대상 없음은 자신.
  //   u._skill · u._atkItem(그 스킬에 공격 단위가 있음)은 효과를 펼칠 때 붙인다(flatEffects).
  //   공식 한국어 스킬은 _skill 이 한국어라 공격 목록(위키 영어)과 _skillEn 으로 맞춘다 (2026-10-08)
  //   → 'all'(파티 전원) | 'self'(본인) | 'skill'(본인의 그 공격 스킬에만) | null
  function allyScope(u) {
    const tc = u.tc || "";
    if (tc === "아군 전체") return "all";
    if (tc === "자신") return "self";
    if (!tc) return u._atkItem ? "skill" : "self";            // 공격 스킬 속 성질(확정 크리 등)은 그 스킬에만
    return null;
  }
  const enemySide = u => /적/.test(u.tc || "") || (!u.tc && u.dir === "DOWN");
  const usable = (u, opt) => !u.explain && u.k !== "meta" && (!u.cond || opt.cond);

  // 자리 조건 — 효과가 보유자의 위치를 요구하는가(화면 · 탐색 공용, 2026-10-08 index.html 에서 옮김)
  const POS_BACK = /후방에서|후방에 있|(?:user|self) (?:is )?(?:in|on) (?:the )?(?:back ?-?line|reserve)|\bin (?:the )?reserve\b|from (?:the )?reserve/i;
  const POS_FRONT = /전방에서|전방에 있는 경우|(?:user|self) (?:is )?(?:in|on) (?:the )?front ?-?line|if in (?:the )?front ?-?line|when in (?:the )?front ?-?line/i;
  function posReq(u) {
    const t = (u.cond || "") + " " + (u.raw || "");
    if (POS_BACK.test(t)) return "back";
    if (POS_FRONT.test(t)) return "front";              // 「user is in the front line and there are 4 …」 — 위치와 인원은 따로 판정
    return null;
  }

  // 효과 기여 — 멤버마다 효과 단위를 한 번만 분류해 s._contrib 에 둔다(파티 탐색은 같은 멤버를 수십만 번 합친다).
  //   s.fx 를 바꾸면 s._contrib 를 지울 것
  const newAG = () => ({ pwr: { buffs: [] }, int: { buffs: [] }, spd: { buffs: [] }, type: {}, dmg: { buffs: [] },
    crit: [], mcrit: [], critDmg: [], mcritDmg: [], focusPhys: [], focusMag: [], sureCrit: false, overthrow: false, src: [] });
  const newEG = () => ({ phys: [], magic: [], type: {}, atk: {}, def: [], mdef: [], src: [] });
  function mergeInto(g, h) {
    for (const [k, x] of Object.entries(h)) {
      if (typeof x === "boolean") g[k] = g[k] || x;
      else if (Array.isArray(x)) { if (x.length) g[k].push(...x); }
      else if (x.buffs) { if (x.buffs.length) g[k].buffs.push(...x.buffs); }
      else for (const [e, vs] of Object.entries(x)) (g[k][e] = g[k][e] || []).push(...vs);
    }
    return g;
  }
  function contrib(s, opt) {
    const key = opt.cond ? 1 : 0;
    s._contrib = s._contrib || [];
    if (s._contrib[key]) return s._contrib[key];
    const c = { all: newAG(), self: newAG(), skill: {}, enemy: newEG() };
    for (const u of s.fx) {
      if (!usable(u, opt)) continue;
      const sc = allyScope(u);
      if (sc === "all" || sc === "self") addAlly(c[sc], u, s);
      else if (sc === "skill") for (const n of new Set([u._skill, u._skillEn].filter(Boolean))) addAlly(c.skill[n] = c.skill[n] || newAG(), u, s);
      addEnemy(c.enemy, u, s);
    }
    return (s._contrib[key] = c);
  }

  // 파티 공통분(아군 전체 버프 합 · 적 디버프 합) — 같은 파티 안에서 멤버 · 공격 · 존 · 장비만 바꿔 여러 번 계산할 때 한 번만 만든다.
  //   멤버별 합(own)도 여기 쌓는다 — 파티 구성이 바뀌면 prepare 를 다시 부를 것
  function prepare(members, opt) {
    const all = newAG(), eg = newEG();
    for (const s of members) { const c = contrib(s, opt); mergeInto(all, c.all); mergeInto(eg, c.enemy); }
    return { all, eg, own: new Map() };
  }
  function ownGroups(pre, dst, opt) {
    const own = contrib(dst, opt);
    const sk = dst.attack && own.skill[dst.attack.skill] ? dst.attack.skill : "";
    const key = dst.c.id + "|" + sk;
    if (pre.own && pre.own.has(key)) return pre.own.get(key);
    const g = mergeInto(mergeInto(newAG(), pre.all), own.self);
    if (sk) mergeInto(g, own.skill[sk]);
    if (pre.own) pre.own.set(key, g);
    return g;
  }
  // 한 멤버가 받는 아군 효과 → 그룹
  const allyGroups = (members, dst, opt) => ownGroups({ all: prepare(members, opt).all }, dst, opt);
  // 그룹 순효과 메모 — 같은 그룹 객체에서 같은 키를 다시 계산하지 않는다(그룹은 만든 뒤 바뀌지 않는다)
  function net(g, key, f) {
    const m = g._net || (g._net = new Map());
    if (!m.has(key)) m.set(key, f());
    return m.get(key);
  }
  function addAlly(g, u, s) {
    const v = (u.value || 0) / 100;
    if ((u.k === "stat_pct") && u.dir === "UP") {
      for (const st of u.stats || []) {
        let hit = true;
        if (st === "힘") g.pwr.buffs.push(v);
        else if (st === "지능") g.int.buffs.push(v);
        else if (st === "속도") g.spd.buffs.push(v);
        else if (st === "크리티컬율") g.crit.push(v);
        else if (st === "마법 크리티컬율") g.mcrit.push(v);
        else if (st === "크리티컬 대미지") g.critDmg.push(v);
        else if (st === "마법 크리티컬 대미지") g.mcritDmg.push(v);
        else if (/속성 공격$/.test(st)) {
          const e = ELEMS.find(x => st.startsWith(x)) || (/^모든|^속성 공격$/.test(st) ? "*" : null);
          if (e) (g.type[e] = g.type[e] || []).push(v); else hit = false;
        } else hit = false;
        if (hit) g.src.push(`${s.c.nameKo}: ${st} +${u.value}%`);
      }
    } else if (u.k === "dmg" && u.dir === "UP" && !/받는|피격/.test(u.what || "") && u.what !== "약점 시 대미지") {
      g.dmg.buffs.push(v); g.src.push(`${s.c.nameKo}: ${u.what} +${u.value}%`);
    } else if (u.k === "buff") {
      if (u.name === "정신 통일") { g.focusMag.push(0.0023); g.src.push(`${s.c.nameKo}: 정신 통일`); }
      else if (u.name === "심기일체") { g.focusPhys.push(0.0023); g.src.push(`${s.c.nameKo}: 심기일체`); }
      else if (u.name === "크리티컬 발생 확정") { g.sureCrit = true; g.src.push(`${s.c.nameKo}: 크리티컬 확정`); }
      else if (u.name === "하극상") { g.overthrow = true; g.src.push(`${s.c.nameKo}: 하극상`); }
    }
  }

  // 적에게 거는 디버프 — 저항 그룹(물리 · 속성 · 마법 · 공격 종류별), 내구 · 정신
  function addEnemy(e, u, s) {
    if (u.k !== "stat_pct" || u.dir !== "DOWN" || !enemySide(u)) return;
    const v = (u.value || 0) / 100;
    for (const st of u.stats || []) {
      let hit = true;
      if (st === "물리 저항") e.phys.push(v);
      else if (st === "마법 저항") e.magic.push(v);
      else if (st === "내구") e.def.push(v);
      else if (st === "정신") e.mdef.push(v);
      else if (PHYS.some(a => st === a + " 저항")) (e.atk[st.split(" ")[0]] = e.atk[st.split(" ")[0]] || []).push(v);
      else if (/속성 저항$/.test(st)) {
        const k = ELEMS.find(x => st.startsWith(x)) || "*";
        (e.type[k] = e.type[k] || []).push(v);
      } else hit = false;
      if (hit) e.src.push(`${s.c.nameKo}: 적 ${st} −${u.value}%`);
    }
  }
  function enemyGroups(members, opt) {
    const e = newEG();
    for (const s of members) mergeInto(e, contrib(s, opt).enemy);
    return e;
  }

  // 장비 효과 중 이 공격에 맞는 것 — 대미지 가산 · 곱(페인/독 · 약점) · 크리 · 고정 스탯
  function equipFor(items, atk, opt) {
    const out = { equip: [], punish: 0, skillFx: [], crit: 0, mcrit: 0, critDmg: 0, mcritDmg: 0, stats: {}, src: [] };
    for (const it of items) {
      if (!it) continue;
      for (const [k, v] of Object.entries(it.stats || {})) out.stats[k] = (out.stats[k] || 0) + v;
      for (const f of [...(it.fx || []).filter(f => f.k !== "etc"), ...(it.calc || [])]) {
        if (f.zone && !(opt.zone && opt.zone.name.includes(f.zone))) continue;
        const v = (f.v || 0) / 100;
        if (f.k === "stat") out.stats[f.stat] = (out.stats[f.stat] || 0) + f.v;
        else if (f.k === "dmg") {
          const ok = f.when === "type" || f.when === "all" || (f.when === "nontype" && !atk.element) || f.when === atk.element
            || (f.when === "maxhp" && opt.maxHp);
          if (ok) { out.equip.push(v); out.src.push(`${it.name}: ${f.when} +${f.v}%`); }
        } else if (f.k === "punish" && opt.punish && opt.punish.includes(f.when)) { out.punish++; out.src.push(`${it.name}: ${f.when} ×1.3`); }
        else if (f.k === "skillfx" && f.when === "weak" && opt._weak) { out.skillFx.push(v); out.src.push(`${it.name}: 약점 +${f.v}%`); }
        else if (f.k === "crit_rate") out[f.magic ? "mcrit" : "crit"] += v;
        else if (f.k === "crit_dmg") out[f.magic ? "mcritDmg" : "critDmg"] += v;
      }
    }
    return out;
  }

  function affinityOf(enemy, atk) {
    if (!enemy) return "norm";
    const keys = [atk.element, atk.atk].filter(Boolean);
    for (const [k, a] of [["weak", "weak"], ["resist", "resist"], ["null", "null"], ["absorb", "absorb"]])
      if (keys.some(x => (enemy[k] || []).includes(x))) return a;           // 약점 > 경감 > 무효 > 흡수
    return "norm";
  }
  function zoneMult(zone, atk) {
    if (!zone) return 0;
    const has = (types, x) => types.includes(x);
    let z = 0;
    if (has(zone.up.types, "전체") || has(zone.up.types, atk.element) || has(zone.up.types, atk.atk)) z += (zone.up.v || 0) / 100;
    if (has(zone.down.types, atk.element) || has(zone.down.types, atk.atk)) z -= (zone.down.v || 0) / 100;
    return z;
  }

  // 멤버 한 명의 선택 공격 1타 — {normal, crit, p, expected, why}. pre = prepare(members, opt) 를 넘기면 파티 공통분을 다시 만들지 않는다
  function memberDamage(m, members, opt, pre) {
    const atk = m.attack;
    if (!atk || !(atk.mult || atk.multMax)) return null;              // 기본 0%(「0%-27500%」 스택 전용)는 조건부에서만 대미지
    pre = pre || prepare(members, opt);
    const ag = ownGroups(pre, m, opt), eg = pre.eg;
    const aff = affinityOf(opt.enemy, atk);
    const eq = equipFor([m.weapon, m.armor, ...(m.grasta || []), ...(m.badges || [])], atk, { ...opt, _weak: aff === "weak" });
    const st = { ...m.stats };
    for (const [k, v] of Object.entries(eq.stats)) st[k] = (st[k] || 0) + v;
    const magic = atk.dep === "magic" || atk.dep === "magicpwr";
    const typeKey = atk.element || null;
    const typeNet = net(ag, "t" + typeKey, () => C.groupNet({ buffs: typeKey ? [...(ag.type["*"] || []), ...(ag.type[typeKey] || [])] : (ag.type["*"] || []) }));
    const groups = [typeNet, net(ag, "dmg", () => C.groupNet(ag.dmg))];
    const focus = magic ? ag.focusMag : ag.focusPhys;
    if (focus.length) groups.push(C.focusGroup([C.mentalFocus(st.mp || 0, focus)]));
    if (ag.overthrow && opt.enemy && opt.enemy.lv) groups.push(Math.min(1, opt.enemy.lv * opt.enemy.lv / 200 / 100));
    const en = opt.enemy || { end: 0, spr: 0 };
    // skillMult — 범위 배율(150~18000%)의 위값(multMax)은 조건부(스택 · HP 소모 · 모드)라 opt.cond 일 때만
    const o = {
      dep: atk.dep, elemental: !!atk.element, stat: st, weapon: { atk: (m.weapon || {}).atk || 0, matk: (m.weapon || {}).matk || 0 },
      buff: { pwr: net(ag, "pwr", () => C.groupNet(ag.pwr)), int: net(ag, "int", () => C.groupNet(ag.int)), spd: net(ag, "spd", () => C.groupNet(ag.spd)) },
      enemy: { def: (en.end || 0) * (1 - net(eg, "def", () => C.groupNet({ buffs: eg.def }))),
        mdef: (en.spr || 0) * (1 - net(eg, "mdef", () => C.groupNet({ buffs: eg.mdef }))) },
      affinity: aff, skillMult: ((opt.cond && atk.multMax) || atk.mult) / 100, skillFx: eq.skillFx, zone: zoneMult(opt.zone, atk),
      resDown: { phys: net(eg, "p" + atk.atk, () => C.groupNet({ buffs: [...eg.phys, ...(eg.atk[atk.atk] || [])] })),
        type: net(eg, "t" + typeKey, () => C.groupNet({ buffs: typeKey ? [...(eg.type["*"] || []), ...(eg.type[typeKey] || [])] : [] })),
        magic: net(eg, "magic", () => C.groupNet({ buffs: eg.magic })) },
      groups, punish: eq.punish, equip: eq.equip, single: /적 하나|랜덤/.test(atk.scope || ""), rand: "avg",
    };
    const normal = C.damage({ ...o, crit: false }).total;
    const crit = C.damage({ ...o, crit: true, critDmg: magic ? C.additive([...ag.mcritDmg, eq.mcritDmg]) : C.additive([...ag.critDmg, eq.critDmg]) }).total;
    const p = magic ? Math.min(1, C.additive([...ag.mcrit, eq.mcrit])) : (ag.sureCrit ? 1 : C.critChance({ lck: st.lck, critRate: C.additive([...ag.crit, eq.crit]) }));
    return { normal, crit, p, expected: p * crit + (1 - p) * normal, o, get why() { return [...ag.src, ...eg.src, ...eq.src]; } };
  }

  // 기본 장비 — 무기 종류가 같고 공격(마법이면 마법 공격) 최대
  function bestWeapon(weapons, type, magic) {
    let best = null;
    for (const w of weapons) if (w.type === type && (!best || (magic ? w.matk : w.atk) > (magic ? best.matk : best.atk))) best = w;
    return best;
  }

  const api = { allyGroups, enemyGroups, prepare, equipFor, affinityOf, zoneMult, memberDamage, bestWeapon, posReq, contrib };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AEParty = api;
})(typeof window !== "undefined" ? window : globalThis);
