// 파티 효과(효과 단위) → 엔진 입력 → 멤버별 1타 기대값 (2026-10-07)
//   「버프 · 디버프 · 존을 다 깐 뒤 주력기 1타」 정적 추정. 턴 · 지속 · 순서는 보지 않는다(로드맵 L4).
//   입력 효과는 skills_ko/skills_en 의 단위(k · stats · dir · value · tc · cond …), 장비는 data/calc.
//   브라우저(window.AEParty) · node 공용. 테스트: _tools/character/tests/test_party_calc.cjs
(function (root) {
  "use strict";
  const C = root.AECalc || require("./ae_calc.js");
  const T = root.AETerms || require("./concepts.js");   // 개념 레지스트리 — 효과 이름 → 개념 id(T.cid), id → 한국어(T.ko). 엔진은 화면 이름을 직접 비교하지 않는다
  const KL = k => T.short(T.calc(k));                   // 장비 fx 계산 키(aim · weak · growth …) → 근거 줄 이름(레지스트리 sub equip 의 짧은 이름)
  const ELEMS = ["불", "물", "땅", "바람", "번개", "그림자", "결정"];
  const PHYS = ["베기", "찌르기", "타격"];

  // 받는 쪽 — 아군 효과는 「아군 전체 · 자신」만(특정 아군은 누구인지 모름 → 제외), 대상 없음은 자신.
  //   u._skill · u._atkItem(그 스킬에 공격 단위가 있음)은 효과를 펼칠 때 붙인다(flatEffects).
  //   공식 한국어 스킬은 _skill 이 한국어라 공격 목록(위키 영어)과 _skillEn 으로 맞춘다 (2026-10-08)
  //   → 'all'(파티 전원) | 'self'(본인) | 'skill'(본인의 그 공격 스킬에만) | null
  function allyScope(u) {
    if (u._self) return "self";                         // 시나리오가 수신자별 잔여 횟수로 펼친 효과
    const tc = u.tc || "";
    if (tc === "아군 전체") return Array.isArray(u.who) && u.who.length ? "who" : "all";
    if (tc === "자신") return "self";
    if (!tc) return u._atkItem ? "skill" : "self";            // 공격 스킬 속 성질(확정 크리 등)은 그 스킬에만
    return null;
  }
  // 조건 아군(u.who = 꼬리표 목록 — 무기 · 속성 · 천명 · 성격, 2026-11-13 감사): 하나라도 맞는 아군만 받는다. 무기는 실제 장착 무기 → 직업 무기
  //   전엔 「<지팡이> 아군」 · 「Bow equipped characters」가 「특정 아군」(아무도 안 받음)이나 아군 전체(전원)로 뭉개졌다
  function recvOk(m, who) {
    const c = (m && m.c) || {}, wp = (m && ((m.weapon && m.weapon.type) || (m.cc && m.cc.weapon))) || c.weaponKo || "";
    return who.some(t => t === "천" || t === "light" ? c.ls === "light" : t === "명" || t === "shadow" ? c.ls === "shadow"
      : wp === t || c.elementKo === t || c.element2Ko === t || (c.traits || []).includes(t));
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
  const STAT_KEYS = { pwr: "pwr", int: "int", spd: "spd", max_mp: "mp", lck: "lck" };
  const newAG = () => ({ pwr: { buffs: [], debuffs: [] }, int: { buffs: [], debuffs: [] }, spd: { buffs: [], debuffs: [] }, mp: { buffs: [], debuffs: [] }, flat: {}, type: {}, dmg: { buffs: [] }, wdmg: {},
    crit: [], mcrit: [], critDmg: [], mcritDmg: [], weak: [], focusPhys: [], focusMag: [], sureCrit: false, overthrow: false,
    minds_eye: false, risktaker: false, overcritical: false, magic_overcritical: false, multi_upgrade: false, sacrifice: false, eagle_eyes: [], src: [], srcTag: [] });   // 상태 칸 = 개념 id
  const newEG = () => ({ phys: [], magic: [], type: {}, atk: {}, def: [], mdef: [], breaks: [], src: [], srcTag: [] });
  function mergeInto(g, h) {
    for (const [k, x] of Object.entries(h)) {
      if (typeof x === "boolean") g[k] = g[k] || x;
      else if (Array.isArray(x)) { if (x.length) g[k].push(...x); }
      else if (x.buffs) { for (const dir of ["buffs", "debuffs"]) if (x[dir] && x[dir].length) (g[k][dir] = g[k][dir] || []).push(...x[dir]); }
      else for (const [e, vs] of Object.entries(x)) (g[k][e] = g[k][e] || []).push(...vs);
    }
    return g;
  }
  function contrib(s, opt) {
    const key = opt.cond ? 1 : 0;
    s._contrib = s._contrib || [];
    if (s._contrib[key]) return s._contrib[key];
    const c = { all: newAG(), self: newAG(), skill: {}, enemy: newEG(), who: [] };
    for (const u0 of s.fx) {
      if (!usable(u0, opt)) continue;
      // 값 범위(2026-10-15) — 위값(누적 최대 · ANOTHER ZONE · 진 전개 2배 …)은 「조건부 효과 포함」일 때만, 기본은 아래값(base · 딩님 표로 올리기 전 _base).
      //   공격 배율(mult/multMax)과 같은 규칙. 위값이 조건 없이 들어가 요르나 1회 542억 같은 값이 났다
      const lo = u0.base ?? u0._base;
      const u = !opt.cond && typeof lo === "number" && lo < u0.value ? { ...u0, value: lo } : u0;
      if (u.value == null && (u.k === "stat_pct" || u.k === "dmg")) continue;      // 값 없는 단위(「축적 수에 따라 …」)는 계산 · 근거에서 뺀다
      const sc = allyScope(u);
      if (sc === "all" || sc === "self") addAlly(c[sc], u, s);
      else if (sc === "who") c.who.push([u, s]);
      else if (sc === "skill") for (const n of new Set([u._skill, u._skillEn].filter(Boolean))) addAlly(c.skill[n] = c.skill[n] || newAG(), u, s);
      addEnemy(c.enemy, u, s);
    }
    return (s._contrib[key] = c);
  }

  // 파티 공통분(아군 전체 버프 합 · 적 디버프 합) — 같은 파티 안에서 멤버 · 공격 · 존 · 장비만 바꿔 여러 번 계산할 때 한 번만 만든다.
  //   멤버별 합(own)도 여기 쌓는다 — 파티 구성이 바뀌면 prepare 를 다시 부를 것
  function prepare(members, opt) {
    const all = newAG(), eg = newEG(), who = [];
    for (const s of members) { const c = contrib(s, opt); mergeInto(all, c.all); mergeInto(eg, c.enemy); who.push(...c.who); }
    return { all, eg, who, own: new Map() };
  }
  function ownGroups(pre, dst, opt) {
    const own = contrib(dst, opt);
    const sk = dst.attack && own.skill[dst.attack.skill] ? dst.attack.skill : "";
    const key = dst.c.id + "|" + sk;
    if (pre.own && pre.own.has(key)) return pre.own.get(key);
    const g = mergeInto(mergeInto(newAG(), pre.all), own.self);
    for (const [u, s] of pre.who || []) if (recvOk(dst, u.who)) addAlly(g, u, s);
    if (sk) mergeInto(g, own.skill[sk]);
    if (pre.own) pre.own.set(key, g);
    return g;
  }
  // 한 멤버가 받는 아군 효과 → 그룹
  const allyGroups = (members, dst, opt) => { const p = prepare(members, opt); return ownGroups({ all: p.all, who: p.who }, dst, opt); };
  // 그룹 순효과 메모 — 같은 그룹 객체에서 같은 키를 다시 계산하지 않는다(그룹은 만든 뒤 바뀌지 않는다)
  function net(g, key, f) {
    const m = g._net || (g._net = new Map());
    if (!m.has(key)) m.set(key, f());
    return m.get(key);
  }
  // 상태 효과(data/calc/statuses.json) — 효과 이름을 개념 id 로 풀어(T.cid) 판정. 루나틱은 이름 + 원문으로 어떤 루나틱인지(T.lunatic)
  //   (2026-11-07 전에는 「호시탐탐」 「Eagle Eyes」 같은 화면 이름을 여기 직접 비교해, 표기를 바꾸면 계산이 조용히 끊겼다)
  const MULTI_UP = [1, 1.25, 1.5, 2, 3];   // 다단 강화 n번째 타 배율(index = n − 1, 5타 이후 3)
  const ATK_EN = { slash: "베기", piercing: "찌르기", pierce: "찌르기", blunt: "타격", magic: "마법" };
  const STATUS_IDS = new Set(["minds_eye", "risktaker", "sacrifice", "overcritical", "magic_overcritical", "eagle_eyes", "multi_upgrade", "break"]);   // 엔진 상태 칸 = 개념 id(번역표 없음)
  function statusOf(u) {
    const n = u.name || "";
    let id = T.cid(n);
    if (id === "lunatic" || /^루나틱/.test(n)) id = T.lunatic(`${n} ${u.raw || ""}`);   // 딩님 원천은 k other, 위키 원천은 k buff(11-04)
    if (id && STATUS_IDS.has(id)) return { id };
    const m = n.match(/^(.+?)\((.+)\)$/);                    // 엘리멘탈 브레이크(불) · 웨폰 브레이크(베기 찌르기)
    if (m && T.cid(m[1]) === "elemental_break") return { id: "elemental_break", which: m[2] };
    if (m && T.cid(m[1]) === "weapon_break") return { id: "weapon_break", which: m[2].split(/\s+/).map(x => ATK_EN[x.toLowerCase()] || x) };
    return null;
  }
  const WEAPON_WORDS = [["검", /(?<![가-힣])검|sword/i], ["도끼", /도끼|\bax(?:e)?\b/i], ["도", /(?<![가-힣])도(?![끼가-힣])|katana/i], ["창", /(?<![가-힣])창|lance|spear/i],
    ["활", /(?<![가-힣])활|\bbow/i], ["권갑", /권갑|fist/i], ["망치", /망치|hammer/i], ["지팡이", /지팡이|staff/i]];
  // 속성 공격 UP 그룹(딩님 145296 — 무속성 · 모든 속성 · 각 속성 · 무속성 물리, 특수 연산) 중 이 공격에 닿는 칸.
  //   「모든 속성」 일반 효과는 무속성 공격에도 닿는다(같은 글). 공격 종류 칸(모든 속성 베기 공격력 — 251526 섬영)은 그 종류에만
  function typeBuffs(tmap, el, kind, magic) {
    const out = [];
    for (const [k, arr] of Object.entries(tmap)) {
      const [e, sub] = k.split("|");
      if (!(e === "*" || (el ? e === el : e === "무"))) continue;
      if (sub && !(sub === kind || (sub === "물리" && !magic) || (sub === "마법" && magic))) continue;
      out.push(...arr);
    }
    return out;
  }
  const weaponsOf = t => (/장착자|equipped/i.test(t) && !/모든 무기|any weapon|all weapon/i.test(t) ? WEAPON_WORDS.filter(([, r]) => r.test(t)).map(([w]) => w) : []);
  // 출처 줄 = 시전자 + 그 효과를 건 스킬(u._skill — 시나리오 · flatEffects 가 붙인다, 11-12 사용자 「어디 스킬에서 뭐가 추가」)
  const note = (g, tag, text) => { g.src.push(text); g.srcTag.push(tag); };   // 꼬리표 = 들어간 칸(memberDamage 의 why 가 공격마다 거른다)
  const who = (s, u) => (u._caster || s.c.nameKo) + (u._skill ? ` 「${u._skill}」` : "");
  function addAlly(g, u, s) {
    const v = (u.value || 0) / 100;
    if (u.k === "stat_pct" && (u.dir === "UP" || u.dir === "DOWN")) {
      for (const st of u.stats || []) {
        let hit = true;
        const id = T.cid(st);
        let tag = id;
        const key = STAT_KEYS[id];
        if (u.flat && key) (g.flat[key] = g.flat[key] || []).push((u.dir === "DOWN" ? -1 : 1) * (u.value || 0));
        else if (!u.flat && key && g[key]) g[key][u.dir === "DOWN" ? "debuffs" : "buffs"].push(v);
        else if (u.flat || u.dir !== "UP") hit = false;
        else if (id === "crit_rate") g.crit.push(v);
        else if (id === "magic_crit_rate") g.mcrit.push(v);
        else if (id === "crit_dmg") g.critDmg.push(v);
        else if (id === "magic_crit_dmg") g.mcritDmg.push(v);
        else if (id === "elem_atk") {
          // 칸 키 = 속성(불 · … · * 모든 · 무 무속성) [+ "|" 공격 종류(베기 · 찌르기 · 타격 · 물리 · 마법)] — typeBuffs 가 공격마다 맞는 칸을 모은다
          const e = ELEMS.find(x => st.startsWith(x)) || (/^모든/.test(st) ? "*" : /^무속성/.test(st) ? "무" : null);
          const sub = (st.match(/(베기|찌르기|타격|물리|마법) 공격력$/) || [])[1];
          const key = e && (sub ? `${e}|${sub}` : e);
          if (key) { (g.type[key] = g.type[key] || []).push(v); tag = "type:" + key; } else hit = false;
        } else hit = false;
        if (hit) note(g, tag, `${who(s, u)}: ${st} ${u.dir === "DOWN" ? "-" : "+"}${u.value}${u.flat ? "" : "%"}`);
      }
    } else if (u.k === "dmg" && u.dir === "UP" && T.cid(u.what) === "weak_dmg") {
      // 「약점 시 대미지 N% UP」(낭전-식 · 배지) = 약점 배율 +N/100 가산(딩님 파이프라인 「약점 대미지 UP 합」 · 시련 광석과 같은 자리 — 가정, 10-18 영상 대조로 공백 발견). 약점 타에만 들어간다
      g.weak.push(v); note(g, "weak", `${who(s, u)}: ${T.ko("weak_dmg")} +${u.value}%`);
    } else if (u.k === "dmg" && u.dir === "UP" && ["crit_dmg", "magic_crit_dmg"].includes(T.cid(u.what))) {   // 한국어 해석기는 크리 위력을 dmg 로 낸다 — 일반 대미지가 아님(2026-10-15)
      (T.cid(u.what) === "magic_crit_dmg" ? g.mcritDmg : g.critDmg).push(v); note(g, T.cid(u.what), `${who(s, u)}: ${u.what} +${u.value}%`);
    } else if (u.k === "dmg" && u.dir === "UP" && !/받는|피격/.test(u.what || "")) {
      // 「검 장착자 대미지」 「Lance and Bow equipped characters」 — 그 무기를 든 멤버만(2026-10-15, 전에는 무기 무관하게 모두)
      const ws = weaponsOf(`${u.what || ""} ${u.scope || ""} ${u.tc || ""}`);
      if (ws.length) for (const w of ws) (g.wdmg[w] = g.wdmg[w] || []).push(v);
      else g.dmg.buffs.push(v);
      note(g, ws.length ? "wdmg:" + ws.join("/") : "dmg", `${who(s, u)}: ${u.what} +${u.value}%`);
    } else if (u.k === "buff" || (u.k === "other" && T.cid(u.name) === "multi_upgrade")) {
      const id = T.cid(u.name);
      // 최대 MP 당 비율 — 정신 통일 보통 0.23% · 심기일체 보통 0.16%(딩님 184648 「상태 효과」. 11-09 전엔 심기일체도 0.23 이라 1.44배 과대)
      if (id === "mental_focus") { g.focusMag.push(0.0023); note(g, "focusMag", `${who(s, u)}: ${T.ko(id)}`); }
      else if (id === "singular_focus") { g.focusPhys.push(0.0016); note(g, "focusPhys", `${who(s, u)}: ${T.ko(id)}`); }
      else if (id === "sure_crit") { g.sureCrit = true; note(g, "*", `${who(s, u)}: ${T.ko(id)}`); }
      else if (id === "overthrow") { g.overthrow = true; note(g, "*", `${who(s, u)}: ${T.ko(id)}`); }
      else {
        const st = statusOf(u);
        if (!st || ["break", "elemental_break", "weapon_break"].includes(st.id)) return;
        if (st.id === "eagle_eyes") { if (u.value) g.eagle_eyes.push(u.value / 100); }
        else g[st.id] = true;
        note(g, "*", `${who(s, u)}: ${u.name}${u.value ? " " + u.value + "%" : ""}`);
      }
    }
  }

  // 적에게 거는 디버프 — 저항 그룹(물리 · 속성 · 마법 · 공격 종류별), 내구 · 정신
  function addEnemy(e, u, s) {
    const st = (u.k === "ailment" || u.k === "stack") && !/아군|자신/.test(u.tc || "") ? statusOf(u) : null;
    if (st && ["break", "elemental_break", "weapon_break"].includes(st.id)) {
      const which = st.id === "elemental_break" ? [st.which] : st.id === "weapon_break" ? st.which : ["*"];
      const n = st.id === "break" ? 1 : Math.max(1, Math.floor(u.value || 1));     // 엘리멘탈 · 웨폰 브레이크 「N 축적」 = N 타
      for (let i = 0; i < n; i++) e.breaks.push(...which.map(w => (st.id === "elemental_break" ? "e:" : st.id === "weapon_break" ? "a:" : "") + w));
      note(e, "*", `${who(s, u)}: 적 ${u.name}`);
      return;
    }
    if (u.k !== "stat_pct" || u.dir !== "DOWN" || !enemySide(u)) return;
    const v = (u.value || 0) / 100;
    for (const st of u.stats || []) {
      let hit = true, tag;
      const id = T.cid(st);
      if (id === "phys_res") { e.phys.push(v); tag = "phys"; }
      else if (id === "mag_res") { e.magic.push(v); tag = "magic"; }
      else if (id === "end") { e.def.push(v); tag = "def"; }
      else if (id === "spr") { e.mdef.push(v); tag = "mdef"; }
      else if (PHYS.some(a => st === a + " 저항")) { (e.atk[st.split(" ")[0]] = e.atk[st.split(" ")[0]] || []).push(v); tag = "atk:" + st.split(" ")[0]; }
      else if (id === "elem_res") {
        const k = ELEMS.find(x => st.startsWith(x)) || "*";
        (e.type[k] = e.type[k] || []).push(v); tag = "etype:" + k;
      } else hit = false;
      if (hit) note(e, tag, `${who(s, u)}: 적 ${st} −${u.value}%`);
    }
  }
  function enemyGroups(members, opt) {
    const e = newEG();
    for (const s of members) mergeInto(e, contrib(s, opt).enemy);
    return e;
  }

  // 장비 효과 중 이 공격에 맞는 것 — 대미지 가산 · 곱(페인/독 · 약점) · 크리 · 고정 스탯
  //   조건부 곱(2026-10-13, 위키 「Damage+ (Multiplier)」 계열 — 각자 (1+x)): 성장 opt.turns · 겨누어 쏘기(opt.af 아닐 때) · MP 소비 공격(MP 쓰는 스킬)
  //   · ZONE 각성 opt.zoneAwake · 누계 승리 opt.wins · 천/명 아군 opt.lightAllies/shadowAllies · 봉인 인핸스 opt.sealed
  //   · 적 수 opt.enemyCount · 쓰러진 아군 opt.fallen · 대상 페인/독 opt.punish. 하극상 = 대상 Lv²/d %.
  //   환경 조건(f.env: severe · special · weather · atmos · ground)은 opt.env(data/calc/envs.json 한 항목 — 계열 type · 심화 severe)로 판정
  const baseName = n => (n || "").replace(/\s+(AS|ES|Alter)$/, "").replace(/\s*\((Another|Extra) Style\)$/, "");
  const whoOk = (who, w) => !!w && (baseName(w.nameEn) === who || (w.traits || []).some(t => who.toLowerCase().startsWith(String(t).toLowerCase())));
  const zkey = n => String(n || "").toLowerCase().replace(/[^a-z]/g, "");   // 「Double Strike Stance - Magic Slash」(장비) = 「…: Magic Slash」(zones) — 구두점 무시(11-04)
  const envOk = (cond, env) => !!env && (cond === "severe" ? !!env.severe : env.type === cond);
  function equipFor(items, atk, opt) {
    const out = { equip: [], typeEquip: [], punish: 0, punishV: [], skillFx: [], crit: 0, mcrit: 0, critDmg: 0, mcritDmg: 0, stats: {}, groups: [], slots: {}, skillMul: 1, src: [] };
    // slot = 정밀 엔진(ae_pipeline) 칸 — 근사 엔진에는 모두 곱(groups)으로 들어간다
    const mult = (it, label, x, slot = "condE", raw = x) => {
      if (x > 0) { out.groups.push(x / 100); (out.slots[slot] = out.slots[slot] || []).push(raw); out.src.push(`${it.name}: ${label} +${+x.toFixed(2)}%`); }
    };
    // 효과 중복 불가(위키 「Not stackable」 — 겨누어 쏘기 · MP 소비 공격 · 봉인 인핸스 · 적 수 · 약점 강화 · 약점 공격 글래스터): 장비 전체에서 종류별 최댓값 하나만 (2026-10-13)
    const once = {};
    const fallen = [];   // 쓰러진 아군 한 명당 대미지 UP(장비) = 합연산 · 끼리 상한 +300%(딩님 145296 · 185296, Ver 3.12.60 확인 — 11-09 전엔 장비마다 따로 곱 · 상한 없음)
    const uniq = (key, it, label, x, slot, raw) => { if (x > 0 && !(once[key] && once[key].x >= x)) once[key] = { it, label, x, slot, raw }; };
    for (const it of items) {
      if (!it) continue;
      for (const [k, v] of Object.entries(it.stats || {})) out.stats[k] = (out.stats[k] || 0) + v;
      // 근거 줄(opt.explain — 계산 근거를 모을 때만, 탐색 중엔 문자열을 안 만든다, 11-12): 장비 스탯 · 고정 스탯 효과 · 크리 효과
      if (opt.explain) { const sv = Object.entries(it.stats || {}).filter(([, v]) => v); if (sv.length) out.src.push(`${it.name}: ${sv.map(([k, v]) => `${T.ko(k)} ${v > 0 ? "+" : ""}${v}`).join(" · ")}`); }
      // 잠재 광석 연성(calc_ore — 같은 종류 효과 값 교체 · 없던 효과 추가)은 opt.ore !== false 일 때(최대 강화 기준, 2026-10-13)
      const own = it.calc_ore && opt.ore !== false ? it.calc_ore : it.calc;
      // 특수 광석 효과(f.ore) — 기본 = 항상 켬(위키 Grasta Enhancements 에 조건 연동 서술 없음).
      //   opt.oreGate === true 면 글래스터 자체 계산 효과(스탯 제외)가 지금 조건에서 발동할 때만 켠다 — 미확인 가설(2026-10-14):
      //   태어난 생명 HARD 알마 페인 전/후 ×2.79 는 3턴에만 든 소울 컬랩스(크리 대미지 +25%)를 넣으면 항상 켬 ×2.11 · 연동 ×3.64 — 판정 불가
      const base = (own || []).filter(f => !f.ore && f.k !== "stat");
      const oreOn = opt.oreGate !== true || !base.length || !(own || []).some(f => f.ore) || (() => {
        const t = equipFor([{ name: it.name, calc: base }], atk, opt);
        return t.src.length > 0 || t.crit + t.mcrit + t.critDmg + t.mcritDmg > 0;
      })();
      for (const f of [...(it.fx || []).filter(f => f.k !== "etc"), ...(own || []).filter(f => oreOn || !f.ore)]) {
        // ZONE 조건: 「Another Zone」 = 각성 ZONE 아무거나 · awakened = 그 ZONE 을 각성했을 때만(E. Power of Offense) — 전에는 둘 다 안 봤다(2026-11-03)
        if (f.zone && !(f.zone === "Another Zone" ? opt.zoneAwake : opt.zone && zkey(opt.zone.name).includes(zkey(f.zone)) && (!f.awakened || opt.zoneAwake))) continue;
        if (f.env && !envOk(f.env, opt.env)) continue;
        if (f.loc && f.loc !== opt.loc) continue;                       // 지역 한정(wyrmrest_isle · wyrmrest_isle/darkrealm) — opt.loc 이 같을 때만
        if (f.who && !whoOk(f.who, opt._who)) continue;                  // 「(Noahxis only)」 — 그 캐릭터(또는 성격)가 낄 때만, 누군지 모르면 뺀다(2026-10-14)
        const v = (f.v || 0) / 100;
        if (f.k === "stat") { out.stats[f.stat] = (out.stats[f.stat] || 0) + f.v; if (opt.explain) out.src.push(`${it.name}${f.src ? ` 「${f.src}」` : ""}: ${T.ko(f.stat)} +${f.v}`); }
        else if (f.k === "dmg") {
          const ok = f.when === "type" || f.when === "all" || (f.when === "nontype" && !atk.element) || f.when === atk.element
            || (f.when === "maxhp" && opt.maxHp) || (f.when === "lowhp" && opt.lowHp)
            || (f.when === "normal" && opt.normalAtk);                         // 일반 공격 대미지 UP(37행 — 속성 · HP 와 같은 바탕에서 가산). 전에는 when normal 을 몰라 늘 꺼짐(11-03)
          // ZONE 조건 대미지 = 딩님 계산기 49행 「각성 ZONE 시」 · 50행 「ZONE 시 대미지 UP」(각자 칸, 속성 대미지 35행 합이 아님 — 빌더 대조 2026-11-03)
          if (ok && f.zone) mult(it, `${f.zone} 시`, f.v, f.awakened || f.zone === "Another Zone" ? "zoneAwake" : "zoneCond");
          else if (ok && opt.elemEquipToType && (f.when === atk.element || f.when === "type") && (opt.elemEquipToType !== "grasta" || ((it.connection !== undefined || it._grasta) && !/^E\. |^극 격진/.test(it.name || "")))) { out.typeEquip.push(v); out.src.push(`${it.name}: ${f.when} +${f.v}% (속성 그룹)`); }   // 실험(11-08 hinaden): 장비 속성 공격을 스킬 속성 버프와 한 칸(감쇠)으로
          else if (ok) { out.equip.push(v); out.src.push(`${it.name}: ${f.when} +${f.v}%`); }
        } else if (f.k === "punish" && opt.punish && opt.punish.includes(f.when)) { out.punish++; out.punishV.push(f.v || 30); out.src.push(`${it.name}: ${f.when} ×${1 + (f.v || 30) / 100}`); }
        // 약점 대미지 강화 — 무기 · 방어구 · 배지 · 글래스터(Weak Point Strike · Moonlit Guidance) · 광석이 모두 같은 효과 「적의 약점 상성에 가하는 대미지 +N%, 효과 중복 불가」
        //   → 장비 전체에서 최댓값 하나, 딩님 계산기 43행 「공격 대미지 UP」(메모 시트 순서 약점 대미지 강화 → MP 소비 → 적 수). 26행 약점 배율이 아님
        //   (2026-11-03 어나더에덴 빌더 대조 — 전에는 무기 · 광석 = 약점 배율 +N/100, 글래스터 = 45행으로 따로 쌓였다)
        else if ((f.k === "weak" || (f.k === "skillfx" && f.when === "weak")) && opt._weak) uniq("weak", it, KL("weak"), f.v);
        else if (f.k === "crit_rate" || f.k === "crit_dmg") {
          out[(f.magic ? "m" : "") + (f.k === "crit_rate" ? "crit" : "critDmg")] += v;
          if (opt.explain && !!f.magic === (atk.dep === "magic" || atk.dep === "magicpwr")) out.src.push(`${it.name}${f.src ? ` 「${f.src}」` : ""}: ${T.ko((f.magic ? "magic_" : "") + f.k)} +${f.v}%`);
        }
        else if (f.k === "growth") mult(it, KL("growth"), Math.min(f.per * (opt.turns || 0), f.max), "growthAtk");
        else if (f.k === "aim" && !opt.af) uniq("aim", it, KL("aim"), f.v, "aim");
        // MP 소비 공격 — 모든 공격(일반 공격 · MP 0 포함). 위키 Recommendation Ore 「Rose with Thorn: Always works」 + 빌더 「일반 공격에도 적용」(11-04, 전에는 MP 쓰는 스킬만)
        else if (f.k === "mpatk") uniq("mpatk", it, KL("mpatk"), f.v);
        else if (f.k === "overthrow" && opt.enemy && opt.enemy.lv) mult(it, KL("overthrow"), Math.floor(opt.enemy.lv * opt.enemy.lv / f.d * 100) / 100, "overthrowE", f.d);
        else if (f.k === "zonedmg" && opt.zoneAwake) mult(it, KL("zonedmg"), f.v, "zoneAwake");
        else if (f.k === "wins" && opt.wins) uniq("wins", it, KL("wins"), f.v, "wins");   // 계산기 입력 55행이 한 칸 — 여러 개면 최댓값 하나(빌더와 같게, 11-03)
        else if (f.k === "lsally") mult(it, `${f.side === "light" ? "천" : "명"} ${KL("lsally")}`, f.per * ((f.side === "light" ? opt.lightAllies : opt.shadowAllies) || 0), "lsAlly");
        else if (f.k === "seal" && opt.sealed) uniq("seal", it, `${T.ko("bind")} ${KL("seal")}`, f.v, "enhance");
        // 페인 · 독 · 도발 인핸스(자신이 그 상태 — opt.selfStatus ['pain'|'poison'|'rage'] = 개념 id) · 그 상태일 때 스탯+ (2026-10-15, 그동안 엔진이 안 읽던 키)
        else if (f.k === "selfstatus" && (opt.selfStatus || []).includes(f.when)) uniq("self:" + f.when, it, `${T.ko(f.when)} ${KL("selfstatus")}`, f.v, "enhance");
        else if (f.k === "selfstat" && f.v && (opt.selfStatus || []).includes(f.when)) out.stats[f.stat] = (out.stats[f.stat] || 0) + f.v;
        else if (f.k === "enemies") uniq("enemies", it, KL("enemies"), f.per * Math.max(0, (opt.enemyCount || 1) - 1));
        else if (f.k === "fallen" && opt.fallen) fallen.push([it, f.per * opt.fallen]);   // 아래에서 합쳐 상한
        else if (f.k === "tstat" && opt.punish && opt.punish.includes(f.when)) mult(it, `${KL("tstat")} ${T.ko(f.when)}`, f.v, "statusE");
        // 전용 무기 스킬 강화 「<스킬> MOD+ 50% · 250% total」 = 기본 배율 +50%p → 배율 × total/(total−v) (스킬 자체 배수 보존)
        else if (f.k === "skillmod" && f.total && atk.skill === f.skill) { out.skillMul *= f.total / (f.total - f.v); out.src.push(`${it.name}: ${f.skill} 배율 +${f.v}%p`); }
      }
    }
    const CONDE = ["weak", "mpatk", "enemies"];   // 43행 안 곱하는 순서(메모 시트)
    const keys = Object.keys(once).sort((a, b) => (CONDE.indexOf(a) + 1 || 99) - (CONDE.indexOf(b) + 1 || 99));
    for (const key of keys) { const u = once[key]; mult(u.it, u.label, u.x, u.slot, u.raw); }
    if (fallen.length) mult({ name: fallen.map(([it]) => it.name).join(" + ") }, KL("fallen"), Math.min(300, fallen.reduce((a, [, x]) => a + x, 0)), "fallen");
    return out;
  }

  // 환경 대미지 보정(2026-10-13) — 우리 공격에 닿는 것만(who ally · both). 각자 곱(딩님 계산기 「가창 · 기도 · 환경」 칸).
  //   호시탐탐(Eagle Eyes)은 정신 통일 그룹, 약점 배율 +1 은 weakBuff. 선제 · 후발 조건은 opt.timing('preemptive'|'delayed')
  function envFor(env, atk, opt) {
    const out = { groups: [], focus: [], weak: 0, src: [] };
    if (!env || !env.dmg) return out;
    const magic = atk.dep === "magic" || atk.dep === "magicpwr";
    for (const d of env.dmg) {
      if (d.k === "eagle_eyes") { out.focus.push(d.v / 100); out.src.push(`${env.name}: ${T.ko("eagle_eyes")} +${d.v}%`); continue; }
      if (d.k === "weak_dmg") { out.weak += d.v / 100; out.src.push(`${env.name}: 약점 배율 +${d.v / 100}`); continue; }   // 환경 dmg 의 k = 개념 id(weak_dmg · eagle_eyes)
      if (d.who === "enemy") continue;
      const w = d.when;
      const ok = w === "*" || (w === "type" && !!atk.element) || (w === "nontype" && !atk.element) || w === atk.element
        || (w === "notShade" && atk.element !== "그림자") || (w === "phys" && !magic) || (w === "magic" && magic)
        || (w === "poisoned" && (opt.punish || []).includes("poison")) || (w === opt.timing);
      if (ok) { out.groups.push(d.v / 100); out.src.push(`${env.name}: ${w} ${d.v > 0 ? "+" : ""}${d.v}%`); }
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
  // 「다른 속성」 = 속성 공격 중 up 속성이 아닌 것(무속성 제외). zone.cond(2026-11-03, 위키 Stances 조건 원문 — 빌더 대조로 발견):
  //   weak/resist = 그 상성이면 up · 다른 속성 값을 cond.v[보통, 각성]으로 대신 · afFull = AF 게이지 가득일 때만(opt.afFull, 기본 = 조건부 효과 포함)
  function zoneMult(zone, atk, aff, opt = {}) {
    if (!zone) return 0;
    const has = (types, x) => types.includes(x);
    const c = zone.cond, upHit = has(zone.up.types, "전체") || has(zone.up.types, atk.element) || has(zone.up.types, atk.atk);
    const other = t => has(t, "다른 속성") && !!atk.element && !upHit;
    if (c && c.when === "afFull" && !(opt.afFull ?? !!opt.cond)) return 0;
    if (c && c.up && aff === c.when && atk.element) { const i = zone.awake ? 1 : 0; return upHit ? c.up[i] / 100 : other(zone.down.types) ? c.other[i] / 100 : 0; }
    let z = 0;
    if (upHit) z += (zone.up.v || 0) / 100;
    if (has(zone.down.types, atk.element) || has(zone.down.types, atk.atk) || other(zone.down.types)) z -= (zone.down.v || 0) / 100;
    return z;
  }

  // 공격의 조건부 배수(atk.conds) 중 지금 켜진 것 — {all: 곱, crit: 크리 전용 곱, on: [조건]} (2026-10-15 S7)
  //   상성 · 대상 상태(opt.punish · opt.targetStates) · 크리 · HP(opt.maxHp/lowHp) · 존(opt.zone · zoneAwake) · 적 수 · 선후(opt.enemyFirst)
  //   · AF(opt.af) · 스텔라(opt.stellar)는 자동, 자기 상태 · 스택 · 비례 · 턴 · 기타는 opt.states(라벨 목록)에 있을 때만
  //   11-04 자동 추가(위키 원천 라벨 — 상태로 확실히 판정되는 것만): 턴(첫 턴 · 처음 N턴 = opt.turns, 전투 1회 · 첫 사용 = opt.firstUse — 시나리오가 넘김) ·
  //     「When in Lunatic」 = 루나틱 플래그 · 「N or more <속성> Characters are in the frontline」 = 실제 전방 · 「when enemy has pain」 = 대상 페인.
  //     모드 · 고유 스택 · 비례(×10~×60, 그 누적 흐름을 시나리오가 모름)는 그대로 opt.states · 조건부 포함에서만
  const EL_EN = { fire: "fire", water: "water", wind: "wind", earth: "earth", thunder: "thunder", crystal: "crystal", shade: "shade" };
  function autoCond(c, opt, x) {
    const l = c.label || "";
    let r;
    if (c.t === "turn") {
      if ((r = /first (\d+) turns/i.exec(l))) return (opt.turns || 0) >= 1 && opt.turns <= +r[1];
      if (/first turn/i.test(l)) return opt.turns === 1;
      if (/once per battle|first time/i.test(l)) return !!opt.firstUse;
    }
    if (c.t === "state" && /in Lunatic/i.test(l)) return !!x.lun;
    if (c.t === "other" && /enemy has pain/i.test(l)) return x.tgt.includes("pain");
    if (c.t === "other" && (r = /(\d+) or more (\w+) Characters are in the frontline/i.exec(l)) && EL_EN[r[2].toLowerCase()])
      return (x.members || []).filter(m => m.pos !== "back" && m.c && m.c.element === EL_EN[r[2].toLowerCase()]).length >= +r[1];
    return false;
  }
  const PEAK_FREE = new Set(["state", "stack", "scale", "turn", "stellar", "af", "hp"]);
  function condMult(atk, aff, opt, brk, x = {}) {
    const out = { all: 1, crit: 1, on: [] };
    const tgt = [...(opt.punish || []), ...(opt.targetStates || [])];
    const zn = opt.zone && opt.zone.name ? opt.zone.name.toLowerCase() : "";
    for (const c of atk.conds || []) {
      // 고점(opt.peak, 11-05 사용자 「4개 다 쓸 수 있다 · 고점 기준 · 단순하게」): 상황이 정하는 조건(상성 · 대상 상태 · 존 · 적 수 · 크리 · 파티 구성)은 실제대로,
      //   나머지(누적 · 모드 · 비례 · HP · AF · 턴 · 스텔라)는 켠다 — 단 반복 고점("repeat")은 1회성(턴 = 첫 턴 · 첫 사용 · 전투 1회, 스텔라)을 끈다. 순간 최고점("burst")은 전부
      if (x.peak && (PEAK_FREE.has(c.t) || (c.t === "other" && !/enemy has pain|Characters are in the frontline/i.test(c.label || "")))) {
        if (x.peak === "repeat" && (c.t === "turn" || c.t === "stellar" || (c.t === "af" && !/not in/i.test(c.label || "")))) continue;   // AF 대미지는 점수 밖(11-13 감사)
        if (c.t === "crit") out.crit *= c.x; else out.all *= c.x;
        out.on.push(c);
        continue;
      }
      const on = c.t === "weak" ? aff === "weak" : c.t === "resist" ? aff === "resist"
        : c.t === "target" ? (c.on === "ailment" ? tgt.length > 0 : c.on === "break" ? !!brk : tgt.includes(c.on))
        : c.t === "crit" ? true
        : c.t === "hp" ? (c.on === "max" ? !!opt.maxHp : !!opt.lowHp)
        : c.t === "zone" ? (c.on === "another" || c.on === "awake" ? !!opt.zoneAwake && (!c.name || zn.includes(c.name.toLowerCase()))
          : c.on === "any" ? !!opt.zone : zn.includes(String(c.on).toLowerCase()))
        : c.t === "enemies" ? (opt.enemyCount || 1) >= 2 : c.t === "enemyFirst" ? !!opt.enemyFirst
        : c.t === "af" ? (/not in/i.test(c.label || "") ? !opt.af : !!opt.af) : c.t === "stellar" ? !!opt.stellar
        : (opt.states || []).includes(c.label) || autoCond(c, opt, { ...x, tgt });
      if (!on) continue;
      if (c.t === "crit") out.crit *= c.x; else out.all *= c.x;
      out.on.push(c);
    }
    return out;
  }

  // P글래스터 공유(2026-10-15) — 다른 파티원이 낀 그라스타 중 잠재 연성 「Also affects all party members (of the matching weapon · Personality)」.
  //   all = 전원 · weapon = 장착자와 같은 무기 · personality = 장착자 · 받는 쪽이 함께 가진 성격(그 그라스타 장착 조건 안).
  //   변형이 하나로 정해진 그라스타(req 1개 — HP 최대 시 강화 <지팡이> · <서방>)는 그 표식으로만 받는 쪽을 고른다(11-09 — 장착자 무기 · 성격 판독이 틀려도 공유,
  //   사용자 「P글래는 예외 없이 파티 효과 활성화」). 받는 쪽 성격 데이터가 비어 있으면(색인 45명) 성격 공유를 받는다고 본다
  //   특수 광석 연성본(it.ore)은 잠재 연성이 아니라 공유 없음, opt.ore === false 도 없음. 스탯은 공유하지 않는다(효과만)
  //   자기 것 + 공유분은 모두 중첩된다(10-15 사용자 확인) — 효과 칸 규칙(장비 대미지 UP 합연산 · 대상 상태 곱연산 …)을 그대로 따른다
  const weaponOfMember = x => (x.weapon && x.weapon.type) || (x.cc && x.cc.weapon) || "";
  function sharedItems(m, members, opt) {
    if (opt.ore === false || !members) return [];
    const out = [], mw = weaponOfMember(m), mt = (m.c && m.c.traits) || [];
    for (const h of members) {
      if (h === m || (h.c && m.c && h.c.id === m.c.id)) continue;
      for (const g of h.grasta || []) {
        if (!g || !g.share || g.ore) continue;
        const ht = (h.c && h.c.traits) || [], req = g.req || [], tag = req.length === 1 ? req[0] : null;
        const ok = g.share === "all" || (g.share === "weapon" && mw && (tag ? mw === tag : mw === weaponOfMember(h) && (!req.length || req.includes(mw))))
          || (g.share === "personality" && (tag ? !mt.length || mt.includes(tag) : ht.some(t => mt.includes(t) && (!req.length || req.includes(t)))));
        if (ok) out.push({ name: `${g.name}(공유: ${(h.c && h.c.nameKo) || ""})`, stats: {}, fx: [], calc: (g.calc_ore || g.calc || []).filter(f => f.k !== "stat"), _grasta: true });
      }
    }
    return out;
  }

  // 버디(BUDDY, 2026-10-17) — opt.buddy = { b: data/calc/buddies.json 한 항목, up: 「스테이터스에 따른 스킬 효과 상승」 %(버디 상세 화면 값), stacks: 누적 수 }
  //   원천: 딩님 「어나더 에덴 스킬 랭킹」 DB_스킬 · DB_효과(_tools/character/build_buddies.py)
  //   오토 스킬(매 턴 끝 발동) — 아군 버프 · 적 디버프 · 브레이크. 누적 수 n = stacks ?? (조건부면 최고 누적, 아니면 max(1, 경과 턴 − 1))
  //   효과량 = 최소 × (1 + up/100), 최대(최소의 1~3배)를 넘지 않음. up 이 없으면 기본 0 · 조건부 200(최대)
  //   n 겹 = 누적형 스킬 버프 규칙 A + A/2 × (n − 1)(위키 Types of stacking · AECalc.halfStack). 효과는 같은 이름 스킬 효과와 같은 감쇠 그룹에 넣는다
  //   ⚠ 버디는 % 적용 방식이 같은 이름의 일반 스킬과 다를 수 있다(10-17 사용자) — 상승 % · 누적 · 그룹은 가정, 측정 계획 docs/ae-damage-formula.md §5.2
  //   오라 — 발동 조건을 공격자마다 판정(환경 계통 · ZONE · 공격 종류 · 속성 · 약점 · MP · 속도). 판정 못 하는 조건(HP · AF 게이지 · 독기 계통 …)은 조건부에서만.
  //     「가하는 대미지 UP」 오라 = 딩님 계산기 v4.016 「오라」 칸(58행 — 가창 · 기도 · 환경 다음, 감쇠 합산 ±100%, 정밀 f.aura). 「크리티컬로 …」는 크리 타격에만(독립 곱 — 가정)
  //   차지 스킬 · [추가 효과](버디 장비 · 동료 조건, u.cond)는 조건부에서만. 버디 자신의 공격 대미지는 넣지 않는다
  //   측정: 큐모스 오버 커밍 브레이크 = 그 뒤 첫 1타만 ×2(10-16 블루스택, 타당 1개 소모 — 10-17 사용자 확인)
  function buddyOn(cond, atk, aff, m, members, opt) {
    if (!cond) return true;
    const magic = atk.dep === "magic" || atk.dep === "magicpwr";
    const zn = (opt.zone && opt.zone.name) || "";
    switch (cond.t) {
      case "env": return !!opt.env && opt.env.type === cond.on;
      case "zone": return zn.includes(cond.on);
      case "weak": return aff === "weak";
      case "atk": return cond.on.includes(atk.atk) || (magic && cond.on.includes("마법"));
      case "elem": return atk.element === cond.on;
      case "mp": return ((m.stats && m.stats.mp) || 0) >= cond.on;
      case "spd": return (members || [m]).some(x => ((x.stats && x.stats.spd) || 0) >= cond.on);
      default: return !!opt.cond;
    }
  }
  function buddyGroups(bd, atk, aff, m, members, opt) {
    const ag = newAG(), eg = newEG(), aura = [], critAura = [];
    const up = bd.up != null && bd.up !== "" ? +bd.up : (opt.cond ? 200 : 0);
    const who = { c: { nameKo: `${bd.b.name}(버디)` } };
    for (const sk of bd.b.skills) {
      if (sk.kind === "charge" && !opt.cond) continue;
      if (sk.kind === "aura" && !buddyOn(sk.cond, atk, aff, m, members, opt)) continue;
      for (const u0 of sk.fx) {
        if (u0.cond && !opt.cond) continue;
        let v = u0.value;
        if (typeof v === "number" && u0.k !== "stack") {
          v = Math.min(u0.max ?? v, v * (1 + up / 100));
          if (sk.kind === "auto" && (u0.maxStack || 1) > 1)
            v = C.halfStack(v, bd.stacks != null && bd.stacks !== "" ? Math.max(1, Math.min(+bd.stacks, u0.maxStack)) : opt.cond ? u0.maxStack : Math.min(u0.maxStack, Math.max(1, (opt.turns || 2) - 1)));
          v = +v.toFixed(2);
        }
        const u = { ...u0, value: v, tc: u0.tc === "특정 아군" && sk.kind === "aura" ? "아군 전체" : u0.tc };   // 오라 「조건을 달성한 대상」 = 지금 판정한 공격자
        if (u.k === "auradmg") {
          const w = u.when || {};
          if (w.af && !opt.af) continue;
          if (w.atk && !(atk.atk === w.atk || (w.atk === "마법" && (atk.dep === "magic" || atk.dep === "magicpwr")))) continue;
          if (w.elemental && !atk.element) continue;
          (w.crit ? critAura : aura).push(v / 100);
          note(ag, "*", `${who.c.nameKo}: ${sk.name} 가하는 대미지 +${v}%${w.crit ? "(크리)" : ""}`);
          continue;
        }
        { const sc = allyScope(u); if (sc === "all" || (sc === "who" && recvOk(m, u.who))) addAlly(ag, u, who); }
        addEnemy(eg, u, who);
      }
    }
    return { ag, eg, aura, critAura };
  }

  // 멤버 한 명의 선택 공격 1타 — {normal, crit, p, expected, why}. pre = prepare(members, opt) 를 넘기면 파티 공통분을 다시 만들지 않는다
  function memberDamage(m, members, opt, pre) {
    const atk = m.attack;
    if (!atk || !(atk.mult || atk.multMax)) return null;              // 기본 0%(「0%-27500%」 스택 전용)는 조건부에서만 대미지
    pre = pre || prepare(members, opt);
    let ag = ownGroups(pre, m, opt), eg = pre.eg;
    const aff = affinityOf(opt.enemy, atk);
    let bud = null;
    if (opt.buddy && opt.buddy.b) {               // 버디 — 오라 조건이 공격자마다 달라 멤버 · 공격 · 상성 단위로 합친다(pre 에 메모)
      const key = `${m.c.id}|${atk.skill}|${aff}`;
      pre.bud = pre.bud || new Map();
      if (!pre.bud.has(key)) {
        const b = buddyGroups(opt.buddy, atk, aff, m, members, opt);
        pre.bud.set(key, { ...b, ag: mergeInto(mergeInto(newAG(), ag), b.ag), eg: mergeInto(mergeInto(newEG(), eg), b.eg) });
      }
      bud = pre.bud.get(key); ag = bud.ag; eg = bud.eg;
    }
    // 후열 셔틀(opt.back = [{c, cc, grasta}], 10-18) — 공격 · 효과 없이 공유 그라스타만 나른다(후방 장착도 공유, docs/ae-game-structure.md §3.4)
    const holders = opt.back && opt.back.length ? [...members, ...opt.back] : members;
    // 천 · 명 아군 수(공명의 힘 「5%×(전후방의 명 아군 수)」 등, 11-08) — 화면이 안 주면 전방 + 후열의 명암(index ls)으로 센다
    const lsN = side => opt[side === "light" ? "lightAllies" : "shadowAllies"] ?? holders.filter(h => h.c && h.c.ls === side).length;
    const eq = equipFor([m.weapon, m.armor, ...(m.grasta || []), ...(m.badges || []), ...sharedItems(m, holders, opt)], atk, { ...opt, lightAllies: lsN("light"), shadowAllies: lsN("shadow"), _weak: aff === "weak", _who: m.c });
    const ev = envFor(opt.env, atk, opt);
    const st = { ...m.stats };
    for (const [k, v] of Object.entries(eq.stats)) st[k] = (st[k] || 0) + v;
    // 고정 스탯도 같은 대상·출처 집계를 사용한다. 행운은 크리율, 나머지는 상태 고정값 칸으로 전달한다.
    const fl0 = { ...(m.flatFx || {}) };
    for (const [k, vals] of Object.entries(ag.flat)) fl0[k] = (fl0[k] || 0) + vals.reduce((a, v) => a + v, 0);
    if (fl0.lck) st.lck = (st.lck || 0) + fl0.lck;
    delete fl0.lck;
    const mpBuff = net(ag, "mp", () => C.groupNet(ag.mp));
    const mpBase = (st.mp || 0) + (fl0.mp || 0), maxMp = Math.max(0, mpBase + Math.trunc(Number((mpBase * mpBuff).toPrecision(15))));
    const magic = atk.dep === "magic" || atk.dep === "magicpwr";
    const typeKey = atk.element || null;
    const tb = typeBuffs(ag.type, typeKey, atk.atk, magic);
    const typeNet = eq.typeEquip.length ? C.groupNet({ buffs: tb, equip: eq.typeEquip }) : net(ag, `t${typeKey}|${atk.atk}|${magic ? 1 : 0}`, () => C.groupNet({ buffs: tb }));
    const wt = (m.weapon && m.weapon.type) || (m.cc && m.cc.weapon) || "";
    const dmgNet = net(ag, "dmg" + wt, () => C.groupNet({ buffs: [...ag.dmg.buffs, ...(ag.wdmg[wt] || [])] }));
    const groups = [typeNet, dmgNet, ...eq.groups, ...ev.groups];
    const auraNet = bud && bud.aura.length ? C.groupNet({ buffs: bud.aura }) : 0;   // 버디 오라 「가하는 대미지 UP」 = 오라 칸(감쇠 합산 ±100%)
    if (auraNet) groups.push(auraNet);
    const focus = magic ? ag.focusMag : ag.focusPhys;
    // 정신 통일 · 심기일체 · 호시탐탐 · 하극상(스킬) — 한 감쇠 그룹(각 상한: 정신 통일 250% · 하극상 100%, 합 350%). 딩님 계산기 행 30~32 (2026-10-13)
    const fv = [...(focus.length ? [C.mentalFocus(maxMp, focus)] : []), ...ev.focus,
      ...(ag.overthrow && opt.enemy && opt.enemy.lv ? [Math.min(1, opt.enemy.lv * opt.enemy.lv / 200 / 100)] : [])];
    // 상태(2026-10-13): 루나틱 · 호시탐탐은 발동 조건(opt.lunatic · opt.enemyFirst, 기본 = 조건부 효과 포함), 브레이크는 opt.breakOn(기본 같음)
    const lun = opt.lunatic ?? !!opt.cond, brk = opt.breakOn ?? !!opt.cond;
    if ((opt.enemyFirst ?? !!opt.cond) && ag.eagle_eyes.length) fv.push(...ag.eagle_eyes);
    const focusV = fv.length ? C.focusGroup(fv) : 0;
    if (fv.length) groups.push(focusV);
    // 브레이크 = 그 뒤 첫 1타만 ×2(10-16 블루스택 세스타 2타 7,967,814 / 3,974,134). 엘리멘탈 · 웨폰은 축적 수만큼, 겹치면 큰 쪽 하나 —
    //   normal · crit · expected 는 첫 타(브레이크 포함), perUse = 첫 타들 + 나머지 타(브레이크 없음). 전에는 모든 타에 ×2 라 다단 히트를 과대평가했다
    const bMatch = b => b === "e:" + atk.element || b === "a:" + atk.atk;
    const nBrk = brk ? Math.max(eg.breaks.includes("*") ? 1 : 0, eg.breaks.filter(bMatch).length) : 0;
    const sx = { mindsEye: lun && ag.minds_eye ? 0.5 : 0, risktaker: lun && ag.risktaker ? 0.7 : 0, brk: nBrk ? 1 : 0 };
    // 루나틱 솔선(2026-11-04 빌더 대조) — 초기 내구만큼 힘 · 초기 정신만큼 지능 = 상태 효과 고정값(딩님 14 · 15행). 초기 = 캐릭터 + 장비(빌더 「솔선의 초기 내구 · 정신」)
    const van = lun && ag.sacrifice;
    const flatFx = van ? { ...fl0, pwr: (fl0.pwr || 0) + (st.end || 0), int: (fl0.int || 0) + (st.spr || 0) } : fl0;
    for (const x of [sx.mindsEye, sx.risktaker]) if (x) groups.push(x);
    // 방어 무시(공격 단위 ignoreDef — 발경참 · 흉랑체, 10-18 영상 대조로 공백 발견) = 그 공격만 적 내구 · 정신 0
    const en = atk._ignoreDef ? { ...(opt.enemy || {}), end: 0, spr: 0 } : (opt.enemy || { end: 0, spr: 0 });
    // skillMult — 범위 배율(150~18000%)의 위값(multMax)은 조건부라 opt.cond 일 때만(모든 조건 최대).
    // 아니면 아래값 × 켜진 조건 배수(atk.conds, 2026-10-15 S7) — 위값을 넘지 않는다. 크리 조건은 크리 타격에만
    const cx = condMult(atk, aff, opt, brk, { lun, members, peak: opt.peak });
    const cap = atk.multMax || Infinity;
    //   고점: 조건이 적혀 있으면 아래값 × 켜진 조건(1회성을 뺄 수 있게), 없으면 위값(누적 최대 등 — 원인이 안 적힌 범위). 반복 고점에서 위값이 1회성 · 마무리(_burstMax)면 아래값
    //   반복 고점 위값 multRep(딩님 원천 — 1회성 블록(SB · 최초 사용 · 첫 턴 · AF) 배수를 뺀 위값, 빌더 rep_power 11-13)이 있으면 그 값. 스텔라 버스트 중(opt.stellar)은 위값 그대로
    const baseMult = opt.peak ? ((atk.conds || []).length ? Math.min(cap, (atk.mult || 0) * cx.all) : opt.peak === "repeat" && atk.multRep != null && !opt.stellar ? atk.multRep : opt.peak === "repeat" && atk._burstMax ? atk.mult || 0 : atk.multMax || atk.mult || 0)
      : (opt.cond && atk.multMax) || Math.min(cap, (atk.mult || 0) * cx.all);
    const critX = Math.min(cx.crit, cap / Math.max(baseMult, 1e-9)) * (bud ? bud.critAura.reduce((a, v) => a * (1 + v), 1) : 1);
    const o = {
      dep: atk.dep, elemental: !!atk.element, stat: st, weapon: { atk: (m.weapon || {}).atk || 0, matk: (m.weapon || {}).matk || 0 },
      buff: { pwr: net(ag, "pwr", () => C.groupNet(ag.pwr)), int: net(ag, "int", () => C.groupNet(ag.int)), spd: net(ag, "spd", () => C.groupNet(ag.spd)), mp: mpBuff },
      enemy: { def: (en.end || 0) * (1 - net(eg, "def", () => C.groupNet({ buffs: eg.def }))),
        mdef: (en.spr || 0) * (1 - net(eg, "mdef", () => C.groupNet({ buffs: eg.mdef }))) },
      affinity: aff, skillMult: baseMult / 100 * eq.skillMul, skillFx: eq.skillFx, zone: zoneMult(opt.zone, atk, aff, opt),
      resDown: { phys: net(eg, "p" + atk.atk, () => C.groupNet({ buffs: [...eg.phys, ...(eg.atk[atk.atk] || [])] })),
        type: net(eg, "t" + typeKey, () => C.groupNet({ buffs: typeKey ? [...(eg.type["*"] || []), ...(eg.type[typeKey] || [])] : [] })),
        magic: net(eg, "magic", () => C.groupNet({ buffs: eg.magic })) },
      stacks: flatFx,                                       // 상태 효과 고정값(scenario flatFx) — 공격력 · 약점 기준에만, /32 배율엔 안 들어감(ae_calc stacks = 딩님 14~16행)
      groups, punish: eq.punish, punishV: eq.punishV, equip: eq.equip, weakBuff: ev.weak + (sx.mindsEye ? 1 : 0) + Math.max(0, ...ag.weak),   /* 약점 시 대미지 UP(+1) 은 여러 명이 걸어도 하나 — 겹친다는 근거 없음 · 딩님 계산기 26행 한 칸(11-07 가정) */ single: /적 하나|랜덤|특정 적/.test(atk.scope || ""), rand: "avg",   /* 「특정 적」 = 딩님 「각각의 적에게」 — 광역이지만 단일 판정 ×1.1(아카 148561895 · 165546619 · 172072927, 11-09) */
    };
    const critDmg = magic ? C.additive([...ag.mcritDmg, eq.mcritDmg]) : C.additive([...ag.critDmg, eq.critDmg]);
    // 오버 크리: 크리 대미지 ×2 확률 = (크리율 − 100%) / 1000% (위키 Status Effects)
    const rate = magic ? C.additive([...ag.mcrit, eq.mcrit]) : (st.lck || 0) / 1600 + C.additive([...ag.crit, eq.crit]);
    const oc = (magic ? ag.magic_overcritical : ag.overcritical) ? Math.max(0, Math.min(1, (rate - 1) / 10)) : 0;
    // 25억 경감(opt.cap === false 면 끔) — 1타마다. 최적화 목표가 캡을 모르면 1타가 큰 조합을 과대평가한다(2026-10-15, 추천 상위가 1타 수십억)
    const capF = opt.cap === false ? v => v : C.softCap;
    const hitOf = ob => [capF(C.damage({ ...ob, crit: false }).total), capF(C.damage({ ...ob, crit: true, critDmg }).total * (1 + oc) * critX)];
    const p = (ag.sureCrit || sx.risktaker) ? 1 : Math.max(0, Math.min(1, rate));
    // 다단 강화(Multi-upgrade, 2026-11-04 빌더 대조 — statuses.json 에 있었으나 미반영): 한 행동의 n번째 타 위력 ×1 · 1.25 · 1.5 · 2 · 3(이후 3, 위키 Damage Formula/Multipliers).
    //   딩님 v4.016 = 위력 % UP 칸(합산). opt.hitOffset = 이 공격 앞에 같은 행동에서 이미 친 타수(시나리오가 넘긴다). 25억 경감은 타마다
    const hits = Math.max(1, atk.hits || 1), h0 = opt.hitOffset || 0;
    const mhOf = j => (ag.multi_upgrade ? MULTI_UP[Math.min(h0 + j, MULTI_UP.length - 1)] : 1);
    const memoH = new Map(), expOf = (f, b) => {
      const key = f + (b ? "b" : "");
      if (!memoH.has(key)) { const ob = f === 1 ? o : { ...o, skillMult: o.skillMult * f }, [n, c] = hitOf(b ? { ...ob, groups: [...groups, 1] } : ob); memoH.set(key, [n, c, p * c + (1 - p) * n]); }
      return memoH.get(key);
    };
    const kb = Math.min(hits, nBrk), f0 = mhOf(0);
    const [normal, crit, exp1] = expOf(f0, kb > 0), rest = expOf(f0, false)[2];
    let perUse = 0;
    // perUse = 1회 사용 기대 대미지(타수만큼) — 스킬 · 장비 · 파티 비교는 이걸로(1타끼리 비교하면 다단 히트가 저평가된다, 2026-10-15). 브레이크 = 앞 kb 타
    for (let j = 0; j < hits; j++) perUse += expOf(mhOf(j), j < kb)[2];
    // 출처 줄 거르기(11-12) — 꼬리표 = 들어간 칸. 스탯 % 는 이 공격의 위력 기반 스탯만, 속성 · 무기 · 물리/마법 칸은 이 공격에 맞는 것만
    const depStat = { pwr: "pwr", int: "int", spd: "spd", magic: "int", magicpwr: "pwr" }[atk.dep] || "pwr";
    const usedTag = t => {
      if (!t || t === "*" || t === "dmg") return true;
      if (t === "pwr" || t === "int" || t === "spd") return t === depStat;
      if (t === "crit_rate" || t === "crit_dmg" || t === "focusPhys") return !magic;
      if (t === "magic_crit_rate" || t === "magic_crit_dmg" || t === "focusMag") return magic;
      if (t === "weak") return aff === "weak";
      if (t.startsWith("type:")) { const k = t.slice(5); return typeBuffs({ [k]: [1] }, typeKey, atk.atk, magic).length > 0; }
      if (t.startsWith("wdmg:")) return t.slice(5).split("/").includes(wt);
      if (t === "phys" || t === "def") return !magic;
      if (t === "magic" || t === "mdef") return magic;
      if (t.startsWith("atk:")) return t.slice(4) === atk.atk;
      if (t.startsWith("etype:")) { const k = t.slice(6); return !!typeKey && (k === "*" || k === typeKey); }
      return true;
    };
    const pick = (g, on) => g.src.filter((_, i) => usedTag(g.srcTag[i]) === on);
    const res = { normal, crit, p, expected: exp1, rest, hits, perUse, o, conds: cx.on,
      get why() { return [...pick(ag, true), ...pick(eg, true), ...eq.src, ...ev.src, ...(fv.length ? [`MP · 상태 비례 그룹(정신 통일 · 심기일체 · 호시탐탐 · 하극상): +${(focusV * 100).toFixed(1)}% (최대 MP ${maxMp}${focus.length ? ` × ${focus.map(x => (x * 100).toFixed(2) + "%").join(" + ")}` : ""})`] : []), ...cx.on.map(c => `조건: ${c.label} ×${c.x}`), ...(kb ? [`브레이크: 첫 ${kb}타 ×2`] : [])]; },
      get whyOff() { return [...pick(ag, false), ...pick(eg, false)]; } };
    // 정밀값(ae_pipeline — 딩님 계산기와 정수 일치 엔진): 난수 전 구간 평균. 근사보다 0~0.4% 낮다(단계마다 버림)
    // pipeInput = 정밀 엔진 입력 그대로(칸별 진단 _tools/character/diagnose_party.cjs 가 칸을 하나씩 빼 본다, 2026-11-07)
    Object.defineProperty(res, "pipeInput", { enumerable: false, get() {
      const KIND = { pwr: "phys", int: "int_phys", spd: "spd_phys", magic: "magic", magicpwr: "pwr_magic" };
      const w = o.weapon, pct = x => (x ? [x * 100] : []), negPct = x => (x ? [-x * 100] : []);
      const defNet = net(eg, "def", () => C.groupNet({ buffs: eg.def })), mdefNet = net(eg, "mdef", () => C.groupNet({ buffs: eg.mdef }));
      const sl = eq.slots, sum = a => (a || []).reduce((x, y) => x + y, 0);
      return { caster: "ally", kind: KIND[atk.dep] || "phys", power: o.skillMult * 100, scope: o.single ? "single" : "all",
        elemental: o.elemental, affinity: o.affinity, cap: opt.cap !== false,
        stats: { mp: st.mp || 0, atk: (st.pwr || 0) + w.atk, matk: (st.int || 0) + w.matk, pwr: st.pwr || 0, int: st.int || 0, spd: st.spd || 0 },
        enemy: { lv: (opt.enemy && opt.enemy.lv) || 0, def: en.end || 0, mdef: en.spr || 0 },
        fx: { power: f0 > 1 ? [(f0 - 1) * 100] : [], flat: Object.fromEntries(Object.entries(flatFx).map(([k, v]) => [k, [v]])), pct: { pwr: pct(o.buff.pwr), int: pct(o.buff.int), spd: pct(o.buff.spd), mp: pct(mpBuff), def: negPct(defNet), mdef: negPct(mdefNet) },
          resPhysMag: negPct(magic ? o.resDown.magic : o.resDown.phys), resType: negPct(o.resDown.type),
          typeNE: pct(typeNet), wielder: pct(dmgNet), eagleEyes: focusV ? [focusV * 100, 0] : [],
          weak: o.weakBuff ? [o.weakBuff * 100] : [], typeE: eq.equip.map(x => x * 100), statusE: [...eq.punishV, ...(sl.statusE || [])],
          enhance: sl.enhance, fallen: sl.fallen, condE: sl.condE, risktaker: sx.risktaker * 100 || undefined, mindsEye: sx.mindsEye * 100 || undefined,
          condNB: o.skillFx.map(x => x * 100), critDmg: pct(critDmg), overCrit: oc * 100 || undefined, aim: sum(sl.aim) || undefined,
          zoneAwake: sl.zoneAwake, zoneCond: sl.zoneCond, lsAlly: sl.lsAlly, overthrowE: sl.overthrowE, growthAtk: sl.growthAtk, wins: (sl.wins || [])[0],
          zone: pct(o.zone), cheer: ev.groups.map(x => x * 100), aura: bud ? bud.aura.map(x => x * 100) : [], break: sx.brk * 100 || undefined } };
    } });
    Object.defineProperty(res, "precise", { enumerable: false, get() {
      const P = root.AEPipe || (typeof require === "function" ? require("./ae_pipeline.js") : null);
      if (!P) return null;
      const r = P.compute(res.pipeInput);
      return { normal: r.avg, crit: r.critAvg * critX, p, expected: p * r.critAvg * critX + (1 - p) * r.avg };
    } });
    return res;
  }

  // 기본 장비 — 무기 종류가 같고 공격(마법이면 마법 공격) 최대
  function bestWeapon(weapons, type, magic) {
    let best = null;
    for (const w of weapons) if (w.type === type && (!best || (magic ? w.matk : w.atk) > (magic ? best.matk : best.atk))) best = w;
    return best;
  }

  // 외부 프리셋(2026-10-17, 개인 세팅 S8) — 「아군이 걸어 주는 버프 · 적 디버프」를 가상 아군 한 명으로 넣는다(엔진 계산은 그대로).
  //   값 = 효과 DB(fx) 분포: 항목마다 그 효과를 아군 전체(또는 적)에게 주는 캐릭터 각자의 값(한 캐릭터 안 여러 단위는 엔진 묶음 규칙 그대로) →
  //   표준 = 중앙값, 최대 = 최댓값(항목마다 가장 센 한 명 — 실제 4인 파티로 다 모으지 못할 수 있다). 상태(심기일체 · 하극상 …)는 최대에서만 켠다.
  //   ctx = 공격 맥락 { element, atk(베기 · 찌르기 · 타격 · 마법), magic, weapon } — 속성 · 공격 종류마다 값이 다르다
  const PRESET = [
    { id: "pwr", label: "힘 UP" }, { id: "int", label: "지능 UP" }, { id: "spd", label: "속도 UP" },
    { id: "type", label: "속성 공격력 UP(공격 속성)" }, { id: "dmg", label: "가하는 대미지 UP(무기 포함)" },
    { id: "crit", label: "물리/마법 크리티컬율 UP", add: true }, { id: "critDmg", label: "물리/마법 크리티컬 위력 UP", add: true },
    { id: "resType", label: "적 속성 저항 DOWN", enemy: true }, { id: "resPhys", label: "적 물리(마법) · 공격 종류 저항 DOWN", enemy: true },
    { id: "def", label: "적 내구(정신) DOWN", enemy: true },
    { id: "focus", label: "심기일체 · 정신 통일", flag: true }, { id: "overthrow", label: "하극상", flag: true },
    { id: "sureCrit", label: "크리티컬 확정", flag: true }, { id: "overcrit", label: "물리/마법 오버 크리티컬", flag: true },
    { id: "mindseye", label: "심안(루나틱)", flag: true }, { id: "risktaker", label: "결사(루나틱)", flag: true },
    { id: "break", label: "적 브레이크", flag: true, enemy: true },
  ];
  function presetValue(id, c, ctx) {
    const a = c.all, e = c.enemy, el = ctx.element, mg = !!ctx.magic, gn = b => (b.length ? C.groupNet({ buffs: b }) : 0);
    switch (id) {
      case "pwr": case "int": case "spd": return gn(a[id].buffs);
      case "type": return gn(typeBuffs(a.type, el, ctx.atk, mg));
      case "dmg": return gn([...a.dmg.buffs, ...(a.wdmg[ctx.weapon] || [])]);
      case "crit": return C.additive(mg ? a.mcrit : a.crit);
      case "critDmg": return C.additive(mg ? a.mcritDmg : a.critDmg);
      case "resType": return el ? gn([...(e.type["*"] || []), ...(e.type[el] || [])]) : 0;
      case "resPhys": return gn(mg ? e.magic : [...e.phys, ...(e.atk[ctx.atk] || [])]);
      case "def": return gn(mg ? e.mdef : e.def);
      case "focus": return (mg ? a.focusMag : a.focusPhys).length ? 1 : 0;
      case "overcrit": return (mg ? a.magic_overcritical : a.overcritical) ? 1 : 0;
      case "mindseye": return a.minds_eye ? 1 : 0;                  // 프리셋 줄 id(브라우저 저장값 cg-ov)는 옛 이름 그대로 — 엔진 칸은 개념 id
      case "break": return e.breaks.some(b => b === "*" || b === "e:" + el || b === "a:" + ctx.atk) ? 1 : 0;
      default: return a[id] ? 1 : 0;
    }
  }
  //   chars = [{ id, nameKo }], fxDb = data/calc/fx.json. 후방에서만 켜지는 단위는 뺀다(전방 아군 기준). 반환 { id → { n, std, max, top } } (값 0~1, 깃발은 1)
  const presetCache = new Map();
  function presetStats(chars, fxDb, ctx, opt = {}) {
    const key = [ctx.element, ctx.atk, !!ctx.magic, ctx.weapon, !!opt.cond].join("|");
    if (presetCache.has(key) && presetCache.get(key).fxDb === fxDb) return presetCache.get(key).out;
    const vals = Object.fromEntries(PRESET.map(p => [p.id, []]));
    for (const ch of chars) {
      const fx = fxDb[ch.id];
      if (!fx || !fx.length) continue;
      const c = contrib({ c: ch, fx: fx.filter(u => posReq(u) !== "back") }, { cond: !!opt.cond });
      for (const p of PRESET) { const v = presetValue(p.id, c, ctx); if (v > 0) vals[p.id].push([v, ch.nameKo]); }
    }
    const out = {};
    for (const p of PRESET) {
      const xs = vals[p.id].sort((x, y) => x[0] - y[0]), n = xs.length;
      const med = n ? (n % 2 ? xs[(n - 1) / 2][0] : (xs[n / 2 - 1][0] + xs[n / 2][0]) / 2) : 0;
      out[p.id] = { ...p, n, std: p.flag ? 0 : med, max: n ? xs[n - 1][0] : 0, top: n ? xs[n - 1][1] : "" };
    }
    presetCache.set(key, { fxDb, out });
    return out;
  }
  //   level = "std" | "max", off = 끈 항목 id 목록. 가상 아군은 공유 글래스터 · 공격이 없다(파티 탐색 후보가 아니다)
  function presetMember(stats, ctx, level, off = []) {
    const fx = [], ally = "아군 전체", foe = "적 전체", mg = !!ctx.magic, el = ctx.element;
    const pct = (st, v, dir = "UP", tc = ally) => fx.push({ k: "stat_pct", stats: [st], dir, value: +(v * 100).toFixed(2), tc });
    for (const p of PRESET) {
      const v = (stats[p.id] || {})[level] || 0;
      if (!v || off.includes(p.id)) continue;
      switch (p.id) {
        case "pwr": pct("힘", v); break;
        case "int": pct("지능", v); break;
        case "spd": pct("속도", v); break;
        case "type": pct(el ? el + " 속성 공격력" : "모든 속성 공격력", v); break;
        case "dmg": fx.push({ k: "dmg", dir: "UP", what: "가하는 대미지", value: +(v * 100).toFixed(2), tc: ally }); break;
        case "crit": pct(mg ? "마법 크리티컬율" : "물리 크리티컬율", v); break;
        case "critDmg": pct(mg ? "마법 크리티컬 위력" : "물리 크리티컬 위력", v); break;
        case "resType": if (el) pct(el + " 속성 저항", v, "DOWN", foe); break;
        case "resPhys": pct(mg ? "마법 저항" : "물리 저항", v, "DOWN", foe); break;
        case "def": pct(mg ? "정신" : "내구", v, "DOWN", foe); break;
        case "focus": fx.push({ k: "buff", name: T.ko(mg ? "mental_focus" : "singular_focus"), tc: ally }); break;
        case "overthrow": fx.push({ k: "buff", name: T.ko("overthrow"), tc: ally }); break;
        case "sureCrit": fx.push({ k: "buff", name: T.ko("sure_crit"), tc: ally }); break;
        case "overcrit": fx.push({ k: "buff", name: T.ko(mg ? "magic_overcritical" : "overcritical"), tc: ally }); break;
        case "mindseye": fx.push({ k: "buff", name: T.ko("minds_eye"), tc: ally }); break;
        case "risktaker": fx.push({ k: "buff", name: T.ko("risktaker"), tc: ally }); break;
        case "break": fx.push({ k: "ailment", name: T.ko("break"), tc: foe }); break;
      }
    }
    return { c: { id: "_preset", nameKo: level === "max" ? "외부 버프(최대)" : "외부 버프(표준)", traits: [] }, fx, grasta: [], badges: [], preset: true };
  }
  const presetCtx = (atk, weapon) => ({ element: (atk && atk.element) || null, atk: (atk && atk.atk) || "", magic: !!atk && (atk.dep === "magic" || atk.dep === "magicpwr"), weapon: weapon || "" });

  const api = { allyScope, allyGroups, enemyGroups, prepare, equipFor, envFor, statusOf, affinityOf, zoneMult, memberDamage, bestWeapon, posReq, contrib, buddyGroups, sharedItems,
    PRESET, presetValue, presetStats, presetMember, presetCtx, envOk, whoOk, recvOk };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AEParty = api;
})(typeof window !== "undefined" ? window : globalThis);
