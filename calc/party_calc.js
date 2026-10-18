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
  const newAG = () => ({ pwr: { buffs: [] }, int: { buffs: [] }, spd: { buffs: [] }, type: {}, dmg: { buffs: [] }, wdmg: {},
    crit: [], mcrit: [], critDmg: [], mcritDmg: [], weak: [], focusPhys: [], focusMag: [], sureCrit: false, overthrow: false,
    mindseye: false, risktaker: false, overcrit: false, movercrit: false, hawk: [], src: [] });
  const newEG = () => ({ phys: [], magic: [], type: {}, atk: {}, def: [], mdef: [], breaks: [], src: [] });
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
    for (const u0 of s.fx) {
      if (!usable(u0, opt)) continue;
      // 값 범위(2026-10-15) — 위값(누적 최대 · ANOTHER ZONE · 진 전개 2배 …)은 「조건부 효과 포함」일 때만, 기본은 아래값(base · 딩님 표로 올리기 전 _base).
      //   공격 배율(mult/multMax)과 같은 규칙. 위값이 조건 없이 들어가 요르나 1회 542억 같은 값이 났다
      const lo = u0.base ?? u0._base;
      const u = !opt.cond && typeof lo === "number" && lo < u0.value ? { ...u0, value: lo } : u0;
      if (u.value == null && (u.k === "stat_pct" || u.k === "dmg")) continue;      // 값 없는 단위(「축적 수에 따라 …」)는 계산 · 근거에서 뺀다
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
  // 상태 효과(2026-10-13, data/calc/statuses.json) — 루나틱 심안 · 결사 · 오버 크리 · 호시탐탐 · 브레이크(대상). 이름(+루나틱은 원문)으로 판정
  const ATK_EN = { slash: "베기", piercing: "찌르기", pierce: "찌르기", blunt: "타격", magic: "마법" };
  function statusOf(u) {
    const n = u.name || "", raw = u.raw || "";
    if (n === "심안" || (n.startsWith("루나틱") && (/심안/.test(n) || /mind'?s eye/i.test(raw)))) return { id: "mindseye" };
    if (n === "결사" || (n.startsWith("루나틱") && (/결사/.test(n) || /risk ?taker/i.test(raw)))) return { id: "risktaker" };
    if (n === "오버 크리티컬") return { id: "overcrit" };
    if (n === "마법 오버 크리티컬") return { id: "movercrit" };
    if (n === "호시탐탐" || n === "Eagle Eyes") return { id: "eagle" };
    if (n === "브레이크") return { id: "break" };
    let m = n.match(/^엘리멘탈 브레이크\((.+)\)$/);
    if (m) return { id: "ebreak", which: m[1] };
    if ((m = n.match(/^웨폰 브레이크\((.+)\)$/))) return { id: "wbreak", which: m[1].split(/\s+/).map(x => ATK_EN[x.toLowerCase()] || x) };
    return null;
  }
  const WEAPON_WORDS = [["검", /(?<![가-힣])검|sword/i], ["도끼", /도끼|ax(?:e)?/i], ["도", /(?<![가-힣])도(?![끼가-힣])|katana/i], ["창", /(?<![가-힣])창|lance|spear/i],
    ["활", /(?<![가-힣])활|bow/i], ["권갑", /권갑|fist/i], ["망치", /망치|hammer/i], ["지팡이", /지팡이|staff/i]];
  const weaponsOf = t => (/장착자|equipped/i.test(t) && !/모든 무기|any weapon|all weapon/i.test(t) ? WEAPON_WORDS.filter(([, r]) => r.test(t)).map(([w]) => w) : []);
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
    } else if (u.k === "dmg" && u.dir === "UP" && u.what === "약점 시 대미지") {
      // 「약점 시 대미지 N% UP」(낭전-식 · 배지) = 약점 배율 +N/100 가산(딩님 파이프라인 「약점 대미지 UP 합」 · 시련 광석과 같은 자리 — 가정, 10-18 영상 대조로 공백 발견). 약점 타에만 들어간다
      g.weak.push(v); g.src.push(`${s.c.nameKo}: 약점 시 대미지 +${u.value}%`);
    } else if (u.k === "dmg" && u.dir === "UP" && /크리티컬 대미지$/.test(u.what || "")) {   // 한국어 해석기는 크리 대미지를 dmg 로 낸다 — 일반 대미지가 아님(2026-10-15)
      (/마법 크리티컬/.test(u.what) ? g.mcritDmg : g.critDmg).push(v); g.src.push(`${s.c.nameKo}: ${u.what} +${u.value}%`);
    } else if (u.k === "dmg" && u.dir === "UP" && !/받는|피격/.test(u.what || "") && u.what !== "약점 시 대미지") {
      // 「검 장착자 대미지」 「Lance and Bow equipped characters」 — 그 무기를 든 멤버만(2026-10-15, 전에는 무기 무관하게 모두)
      const ws = weaponsOf(`${u.what || ""} ${u.scope || ""} ${u.tc || ""}`);
      if (ws.length) for (const w of ws) (g.wdmg[w] = g.wdmg[w] || []).push(v);
      else g.dmg.buffs.push(v);
      g.src.push(`${s.c.nameKo}: ${u.what} +${u.value}%`);
    } else if (u.k === "buff") {
      if (u.name === "정신 통일") { g.focusMag.push(0.0023); g.src.push(`${s.c.nameKo}: 정신 통일`); }
      else if (u.name === "심기일체") { g.focusPhys.push(0.0023); g.src.push(`${s.c.nameKo}: 심기일체`); }
      else if (u.name === "크리티컬 발생 확정") { g.sureCrit = true; g.src.push(`${s.c.nameKo}: 크리티컬 확정`); }
      else if (u.name === "하극상") { g.overthrow = true; g.src.push(`${s.c.nameKo}: 하극상`); }
      else {
        const st = statusOf(u);
        if (!st || ["break", "ebreak", "wbreak"].includes(st.id)) return;
        if (st.id === "eagle") { if (u.value) g.hawk.push(u.value / 100); }
        else g[st.id] = true;
        g.src.push(`${s.c.nameKo}: ${u.name}${u.value ? " " + u.value + "%" : ""}`);
      }
    }
  }

  // 적에게 거는 디버프 — 저항 그룹(물리 · 속성 · 마법 · 공격 종류별), 내구 · 정신
  function addEnemy(e, u, s) {
    const st = (u.k === "ailment" || u.k === "stack") && !/아군|자신/.test(u.tc || "") ? statusOf(u) : null;
    if (st && ["break", "ebreak", "wbreak"].includes(st.id)) {
      const which = st.id === "ebreak" ? [st.which] : st.id === "wbreak" ? st.which : ["*"];
      const n = st.id === "break" ? 1 : Math.max(1, Math.floor(u.value || 1));     // 엘리멘탈 · 웨폰 브레이크 「N 축적」 = N 타
      for (let i = 0; i < n; i++) e.breaks.push(...which.map(w => (st.id === "ebreak" ? "e:" : st.id === "wbreak" ? "a:" : "") + w));
      e.src.push(`${s.c.nameKo}: 적 ${u.name}`);
      return;
    }
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
  //   조건부 곱(2026-10-13, 위키 「Damage+ (Multiplier)」 계열 — 각자 (1+x)): 성장 opt.turns · 겨누어 쏘기(opt.af 아닐 때) · MP 소비 공격(MP 쓰는 스킬)
  //   · ZONE 각성 opt.zoneAwake · 누계 승리 opt.wins · 천/명 아군 opt.lightAllies/shadowAllies · 봉인 인핸스 opt.sealed
  //   · 적 수 opt.enemyCount · 쓰러진 아군 opt.fallen · 대상 페인/독 opt.punish. 하극상 = 대상 Lv²/d %.
  //   환경 조건(f.env: severe · special · weather · atmos · ground)은 opt.env(data/calc/envs.json 한 항목 — 계열 type · 심화 severe)로 판정
  const baseName = n => (n || "").replace(/\s+(AS|ES|Alter)$/, "").replace(/\s*\((Another|Extra) Style\)$/, "");
  const whoOk = (who, w) => !!w && (baseName(w.nameEn) === who || (w.traits || []).some(t => who.toLowerCase().startsWith(String(t).toLowerCase())));
  const envOk = (cond, env) => !!env && (cond === "severe" ? !!env.severe : env.type === cond);
  function equipFor(items, atk, opt) {
    const out = { equip: [], punish: 0, punishV: [], skillFx: [], crit: 0, mcrit: 0, critDmg: 0, mcritDmg: 0, stats: {}, groups: [], weak: 0, slots: {}, skillMul: 1, src: [] };
    // slot = 정밀 엔진(ae_pipeline) 칸 — 근사 엔진에는 모두 곱(groups)으로 들어간다
    const mult = (it, label, x, slot = "condE", raw = x) => {
      if (x > 0) { out.groups.push(x / 100); (out.slots[slot] = out.slots[slot] || []).push(raw); out.src.push(`${it.name}: ${label} +${+x.toFixed(2)}%`); }
    };
    // 효과 중복 불가(위키 「Not stackable」 — 겨누어 쏘기 · MP 소비 공격 · 봉인 인핸스 · 적 수 · 약점 강화 · 약점 공격 글래스터): 장비 전체에서 종류별 최댓값 하나만 (2026-10-13)
    const once = {};
    const uniq = (key, it, label, x, slot, raw) => { if (x > 0 && !(once[key] && once[key].x >= x)) once[key] = { it, label, x, slot, raw }; };
    for (const it of items) {
      if (!it) continue;
      for (const [k, v] of Object.entries(it.stats || {})) out.stats[k] = (out.stats[k] || 0) + v;
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
        if (f.zone && !(opt.zone && opt.zone.name.includes(f.zone))) continue;
        if (f.env && !envOk(f.env, opt.env)) continue;
        if (f.loc && f.loc !== opt.loc) continue;                       // 지역 한정(wyrmrest_isle · wyrmrest_isle/darkrealm) — opt.loc 이 같을 때만
        if (f.who && !whoOk(f.who, opt._who)) continue;                  // 「(Noahxis only)」 — 그 캐릭터(또는 성격)가 낄 때만, 누군지 모르면 뺀다(2026-10-14)
        const v = (f.v || 0) / 100;
        if (f.k === "stat") out.stats[f.stat] = (out.stats[f.stat] || 0) + f.v;
        else if (f.k === "dmg") {
          const ok = f.when === "type" || f.when === "all" || (f.when === "nontype" && !atk.element) || f.when === atk.element
            || (f.when === "maxhp" && opt.maxHp) || (f.when === "lowhp" && opt.lowHp);
          if (ok) { out.equip.push(v); out.src.push(`${it.name}: ${f.when} +${f.v}%`); }
        } else if (f.k === "punish" && opt.punish && opt.punish.includes(f.when)) { out.punish++; out.punishV.push(f.v || 30); out.src.push(`${it.name}: ${f.when} ×${1 + (f.v || 30) / 100}`); }
        // 약점 공격 강화 글래스터(Weak Point Strike)도 「Not stackable」 — 여러 개 껴도 최댓값 하나(2026-10-17, 전에는 3개가 쌓였다)
        else if (f.k === "skillfx" && f.when === "weak" && opt._weak) uniq("weakfx", it, "약점 공격", v);
        else if (f.k === "weak" && opt._weak) uniq("weak", it, "약점 배율", f.v);
        else if (f.k === "crit_rate") out[f.magic ? "mcrit" : "crit"] += v;
        else if (f.k === "crit_dmg") out[f.magic ? "mcritDmg" : "critDmg"] += v;
        else if (f.k === "growth") mult(it, "성장", Math.min(f.per * (opt.turns || 0), f.max), "growthAtk");
        else if (f.k === "aim" && !opt.af) uniq("aim", it, "겨누어 쏘기", f.v, "aim");
        else if (f.k === "mpatk" && atk.mp > 0 && !opt.normalAtk) uniq("mpatk", it, "MP 소비 공격", f.v);
        else if (f.k === "overthrow" && opt.enemy && opt.enemy.lv) mult(it, "하극상", Math.floor(opt.enemy.lv * opt.enemy.lv / f.d * 100) / 100, "overthrowE", f.d);
        else if (f.k === "zonedmg" && opt.zoneAwake) mult(it, "ZONE 각성", f.v, "zoneAwake");
        else if (f.k === "wins" && opt.wins) mult(it, "누계 승리", f.v, "wins");
        else if (f.k === "lsally") mult(it, f.side === "light" ? "천 아군" : "명 아군", f.per * ((f.side === "light" ? opt.lightAllies : opt.shadowAllies) || 0), "lsAlly");
        else if (f.k === "seal" && opt.sealed) uniq("seal", it, "봉인 인핸스", f.v, "enhance");
        // 페인 · 독 · 분노 인핸스(자신이 그 상태 — opt.selfStatus ['pain'|'poison'|'rage']) · 그 상태일 때 스탯+ (2026-10-15, 그동안 엔진이 안 읽던 키)
        else if (f.k === "selfstatus" && (opt.selfStatus || []).includes(f.when)) uniq("self:" + f.when, it, `${{ pain: "페인", poison: "독", rage: "분노" }[f.when] || f.when} 인핸스`, f.v, "enhance");
        else if (f.k === "selfstat" && f.v && (opt.selfStatus || []).includes(f.when)) out.stats[f.stat] = (out.stats[f.stat] || 0) + f.v;
        else if (f.k === "enemies") uniq("enemies", it, "적 수", f.per * Math.max(0, (opt.enemyCount || 1) - 1));
        else if (f.k === "fallen") mult(it, "쓰러진 아군", f.per * (opt.fallen || 0), "fallen");
        else if (f.k === "tstat" && opt.punish && opt.punish.includes(f.when)) mult(it, `대상 ${f.when === "pain" ? "페인" : "독"}`, f.v, "statusE");
        // 전용 무기 스킬 강화 「<스킬> MOD+ 50% · 250% total」 = 기본 배율 +50%p → 배율 × total/(total−v) (스킬 자체 배수 보존)
        else if (f.k === "skillmod" && f.total && atk.skill === f.skill) { out.skillMul *= f.total / (f.total - f.v); out.src.push(`${it.name}: ${f.skill} 배율 +${f.v}%p`); }
      }
    }
    for (const [key, u] of Object.entries(once)) {
      if (key === "weak") { out.weak += u.x / 100; out.src.push(`${u.it.name}: 약점 배율 +${u.x}%`); }
      else if (key === "weakfx") { out.skillFx.push(u.x); out.src.push(`${u.it.name}: 약점 +${+(u.x * 100).toFixed(2)}%`); }
      else mult(u.it, u.label, u.x, u.slot, u.raw);
    }
    return out;
  }

  // 환경 대미지 보정(2026-10-13) — 우리 공격에 닿는 것만(who ally · both). 각자 곱(딩님 계산기 「가창 · 기도 · 환경」 칸).
  //   호시탐탐(Eagle Eyes)은 정신 통일 그룹, 약점 배율 +1 은 weakBuff. 선제 · 후발 조건은 opt.timing('preemptive'|'delayed')
  function envFor(env, atk, opt) {
    const out = { groups: [], focus: [], weak: 0, src: [] };
    if (!env || !env.dmg) return out;
    const magic = atk.dep === "magic" || atk.dep === "magicpwr";
    for (const d of env.dmg) {
      if (d.k === "hawk") { out.focus.push(d.v / 100); out.src.push(`${env.name}: 호시탐탐 +${d.v}%`); continue; }
      if (d.k === "weak") { out.weak += d.v / 100; out.src.push(`${env.name}: 약점 배율 +${d.v / 100}`); continue; }
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
  function zoneMult(zone, atk) {
    if (!zone) return 0;
    const has = (types, x) => types.includes(x);
    let z = 0;
    if (has(zone.up.types, "전체") || has(zone.up.types, atk.element) || has(zone.up.types, atk.atk)) z += (zone.up.v || 0) / 100;
    if (has(zone.down.types, atk.element) || has(zone.down.types, atk.atk)) z -= (zone.down.v || 0) / 100;
    return z;
  }

  // 공격의 조건부 배수(atk.conds) 중 지금 켜진 것 — {all: 곱, crit: 크리 전용 곱, on: [조건]} (2026-10-15 S7)
  //   상성 · 대상 상태(opt.punish · opt.targetStates) · 크리 · HP(opt.maxHp/lowHp) · 존(opt.zone · zoneAwake) · 적 수 · 선후(opt.enemyFirst)
  //   · AF(opt.af) · 스텔라(opt.stellar)는 자동, 자기 상태 · 스택 · 비례 · 턴 · 기타는 opt.states(라벨 목록)에 있을 때만
  function condMult(atk, aff, opt, brk) {
    const out = { all: 1, crit: 1, on: [] };
    const tgt = [...(opt.punish || []), ...(opt.targetStates || [])];
    const zn = opt.zone && opt.zone.name ? opt.zone.name.toLowerCase() : "";
    for (const c of atk.conds || []) {
      const on = c.t === "weak" ? aff === "weak" : c.t === "resist" ? aff === "resist"
        : c.t === "target" ? (c.on === "ailment" ? tgt.length > 0 : c.on === "break" ? !!brk : tgt.includes(c.on))
        : c.t === "crit" ? true
        : c.t === "hp" ? (c.on === "max" ? !!opt.maxHp : !!opt.lowHp)
        : c.t === "zone" ? (c.on === "another" || c.on === "awake" ? !!opt.zoneAwake && (!c.name || zn.includes(c.name.toLowerCase()))
          : c.on === "any" ? !!opt.zone : zn.includes(String(c.on).toLowerCase()))
        : c.t === "enemies" ? (opt.enemyCount || 1) >= 2 : c.t === "enemyFirst" ? !!opt.enemyFirst
        : c.t === "af" ? !!opt.af : c.t === "stellar" ? !!opt.stellar
        : (opt.states || []).includes(c.label);
      if (!on) continue;
      if (c.t === "crit") out.crit *= c.x; else out.all *= c.x;
      out.on.push(c);
    }
    return out;
  }

  // P글래스터 공유(2026-10-15) — 다른 파티원이 낀 그라스타 중 잠재 연성 「Also affects all party members (of the matching weapon · Personality)」.
  //   all = 전원 · weapon = 장착자와 같은 무기 · personality = 장착자 · 받는 쪽이 함께 가진 성격(그 그라스타 장착 조건 안).
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
        const ht = (h.c && h.c.traits) || [], req = g.req || [];
        const ok = g.share === "all" || (g.share === "weapon" && mw && mw === weaponOfMember(h) && (!req.length || req.includes(mw)))
          || (g.share === "personality" && ht.some(t => mt.includes(t) && (!req.length || req.includes(t))));
        if (ok) out.push({ name: `${g.name}(공유: ${(h.c && h.c.nameKo) || ""})`, stats: {}, fx: [], calc: (g.calc_ore || g.calc || []).filter(f => f.k !== "stat") });
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
          ag.src.push(`${who.c.nameKo}: ${sk.name} 가하는 대미지 +${v}%${w.crit ? "(크리)" : ""}`);
          continue;
        }
        if (allyScope(u) === "all") addAlly(ag, u, who);
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
    const eq = equipFor([m.weapon, m.armor, ...(m.grasta || []), ...(m.badges || []), ...sharedItems(m, holders, opt)], atk, { ...opt, _weak: aff === "weak", _who: m.c });
    const ev = envFor(opt.env, atk, opt);
    const st = { ...m.stats };
    for (const [k, v] of Object.entries(eq.stats)) st[k] = (st[k] || 0) + v;
    const magic = atk.dep === "magic" || atk.dep === "magicpwr";
    const typeKey = atk.element || null;
    const typeNet = net(ag, "t" + typeKey, () => C.groupNet({ buffs: typeKey ? [...(ag.type["*"] || []), ...(ag.type[typeKey] || [])] : (ag.type["*"] || []) }));
    const wt = (m.weapon && m.weapon.type) || (m.cc && m.cc.weapon) || "";
    const dmgNet = net(ag, "dmg" + wt, () => C.groupNet({ buffs: [...ag.dmg.buffs, ...(ag.wdmg[wt] || [])] }));
    const groups = [typeNet, dmgNet, ...eq.groups, ...ev.groups];
    const auraNet = bud && bud.aura.length ? C.groupNet({ buffs: bud.aura }) : 0;   // 버디 오라 「가하는 대미지 UP」 = 오라 칸(감쇠 합산 ±100%)
    if (auraNet) groups.push(auraNet);
    const focus = magic ? ag.focusMag : ag.focusPhys;
    // 정신 통일 · 심기일체 · 호시탐탐 · 하극상(스킬) — 한 감쇠 그룹(각 상한: 정신 통일 250% · 하극상 100%, 합 350%). 딩님 계산기 행 30~32 (2026-10-13)
    const fv = [...(focus.length ? [C.mentalFocus(st.mp || 0, focus)] : []), ...ev.focus,
      ...(ag.overthrow && opt.enemy && opt.enemy.lv ? [Math.min(1, opt.enemy.lv * opt.enemy.lv / 200 / 100)] : [])];
    // 상태(2026-10-13): 루나틱 · 호시탐탐은 발동 조건(opt.lunatic · opt.enemyFirst, 기본 = 조건부 효과 포함), 브레이크는 opt.breakOn(기본 같음)
    const lun = opt.lunatic ?? !!opt.cond, brk = opt.breakOn ?? !!opt.cond;
    if ((opt.enemyFirst ?? !!opt.cond) && ag.hawk.length) fv.push(...ag.hawk);
    const focusV = fv.length ? C.focusGroup(fv) : 0;
    if (fv.length) groups.push(focusV);
    // 브레이크 = 그 뒤 첫 1타만 ×2(10-16 블루스택 세스타 2타 7,967,814 / 3,974,134). 엘리멘탈 · 웨폰은 축적 수만큼, 겹치면 큰 쪽 하나 —
    //   normal · crit · expected 는 첫 타(브레이크 포함), perUse = 첫 타들 + 나머지 타(브레이크 없음). 전에는 모든 타에 ×2 라 다단 히트를 과대평가했다
    const bMatch = b => b === "e:" + atk.element || b === "a:" + atk.atk;
    const nBrk = brk ? Math.max(eg.breaks.includes("*") ? 1 : 0, eg.breaks.filter(bMatch).length) : 0;
    const sx = { shingan: lun && ag.mindseye ? 0.5 : 0, kesshi: lun && ag.risktaker ? 0.7 : 0, brk: nBrk ? 1 : 0 };
    for (const x of [sx.shingan, sx.kesshi]) if (x) groups.push(x);
    // 방어 무시(공격 단위 ignoreDef — 발경참 · 흉랑체, 10-18 영상 대조로 공백 발견) = 그 공격만 적 내구 · 정신 0
    const en = atk._ignoreDef ? { ...(opt.enemy || {}), end: 0, spr: 0 } : (opt.enemy || { end: 0, spr: 0 });
    // skillMult — 범위 배율(150~18000%)의 위값(multMax)은 조건부라 opt.cond 일 때만(모든 조건 최대).
    // 아니면 아래값 × 켜진 조건 배수(atk.conds, 2026-10-15 S7) — 위값을 넘지 않는다. 크리 조건은 크리 타격에만
    const cx = condMult(atk, aff, opt, brk);
    const cap = atk.multMax || Infinity;
    const baseMult = (opt.cond && atk.multMax) || Math.min(cap, (atk.mult || 0) * cx.all);
    const critX = Math.min(cx.crit, cap / Math.max(baseMult, 1e-9)) * (bud ? bud.critAura.reduce((a, v) => a * (1 + v), 1) : 1);
    const o = {
      dep: atk.dep, elemental: !!atk.element, stat: st, weapon: { atk: (m.weapon || {}).atk || 0, matk: (m.weapon || {}).matk || 0 },
      buff: { pwr: net(ag, "pwr", () => C.groupNet(ag.pwr)), int: net(ag, "int", () => C.groupNet(ag.int)), spd: net(ag, "spd", () => C.groupNet(ag.spd)) },
      enemy: { def: (en.end || 0) * (1 - net(eg, "def", () => C.groupNet({ buffs: eg.def }))),
        mdef: (en.spr || 0) * (1 - net(eg, "mdef", () => C.groupNet({ buffs: eg.mdef }))) },
      affinity: aff, skillMult: baseMult / 100 * eq.skillMul, skillFx: eq.skillFx, zone: zoneMult(opt.zone, atk),
      resDown: { phys: net(eg, "p" + atk.atk, () => C.groupNet({ buffs: [...eg.phys, ...(eg.atk[atk.atk] || [])] })),
        type: net(eg, "t" + typeKey, () => C.groupNet({ buffs: typeKey ? [...(eg.type["*"] || []), ...(eg.type[typeKey] || [])] : [] })),
        magic: net(eg, "magic", () => C.groupNet({ buffs: eg.magic })) },
      groups, punish: eq.punish, punishV: eq.punishV, equip: eq.equip, weakBuff: eq.weak + ev.weak + (sx.shingan ? 1 : 0) + ag.weak.reduce((a, b) => a + b, 0), single: /적 하나|랜덤/.test(atk.scope || ""), rand: "avg",
    };
    const critDmg = magic ? C.additive([...ag.mcritDmg, eq.mcritDmg]) : C.additive([...ag.critDmg, eq.critDmg]);
    // 오버 크리: 크리 대미지 ×2 확률 = (크리율 − 100%) / 1000% (위키 Status Effects)
    const rate = magic ? C.additive([...ag.mcrit, eq.mcrit]) : (st.lck || 0) / 1600 + C.additive([...ag.crit, eq.crit]);
    const oc = (magic ? ag.movercrit : ag.overcrit) ? Math.max(0, Math.min(1, (rate - 1) / 10)) : 0;
    // 25억 경감(opt.cap === false 면 끔) — 1타마다. 최적화 목표가 캡을 모르면 1타가 큰 조합을 과대평가한다(2026-10-15, 추천 상위가 1타 수십억)
    const capF = opt.cap === false ? v => v : C.softCap;
    const hitOf = ob => [capF(C.damage({ ...ob, crit: false }).total), capF(C.damage({ ...ob, crit: true, critDmg }).total * (1 + oc) * critX)];
    const [n0, c0] = hitOf(o), [normal, crit] = sx.brk ? hitOf({ ...o, groups: [...groups, 1] }) : [n0, c0];
    const p = (ag.sureCrit || sx.kesshi) ? 1 : Math.max(0, Math.min(1, rate));
    // perUse = 1회 사용 기대 대미지(타수만큼) — 스킬 · 장비 · 파티 비교는 이걸로(1타끼리 비교하면 다단 히트가 저평가된다, 2026-10-15)
    const hits = Math.max(1, atk.hits || 1), exp1 = p * crit + (1 - p) * normal, rest = p * c0 + (1 - p) * n0;
    const kb = Math.min(hits, nBrk);
    const res = { normal, crit, p, expected: exp1, rest, hits, perUse: exp1 * kb + rest * (hits - kb), o, conds: cx.on,
      get why() { return [...ag.src, ...eg.src, ...eq.src, ...ev.src, ...cx.on.map(c => `조건: ${c.label} ×${c.x}`), ...(kb ? [`브레이크: 첫 ${kb}타 ×2`] : [])]; } };
    // 정밀값(ae_pipeline — 딩님 계산기와 정수 일치 엔진): 난수 전 구간 평균. 근사보다 0~0.4% 낮다(단계마다 버림)
    Object.defineProperty(res, "precise", { enumerable: false, get() {
      const P = root.AEPipe || (typeof require === "function" ? require("./ae_pipeline.js") : null);
      if (!P) return null;
      const KIND = { pwr: "phys", int: "int_phys", spd: "spd_phys", magic: "magic", magicpwr: "pwr_magic" };
      const w = o.weapon, pct = x => (x ? [x * 100] : []), negPct = x => (x ? [-x * 100] : []);
      const defNet = net(eg, "def", () => C.groupNet({ buffs: eg.def })), mdefNet = net(eg, "mdef", () => C.groupNet({ buffs: eg.mdef }));
      const sl = eq.slots, sum = a => (a || []).reduce((x, y) => x + y, 0);
      const r = P.compute({ caster: "ally", kind: KIND[atk.dep] || "phys", power: o.skillMult * 100, scope: o.single ? "single" : "all",
        elemental: o.elemental, affinity: o.affinity, cap: opt.cap !== false,
        stats: { mp: st.mp || 0, atk: (st.pwr || 0) + w.atk, matk: (st.int || 0) + w.matk, pwr: st.pwr || 0, int: st.int || 0, spd: st.spd || 0 },
        enemy: { lv: (opt.enemy && opt.enemy.lv) || 0, def: en.end || 0, mdef: en.spr || 0 },
        fx: { pct: { pwr: pct(o.buff.pwr), int: pct(o.buff.int), spd: pct(o.buff.spd), def: negPct(defNet), mdef: negPct(mdefNet) },
          resPhysMag: negPct(magic ? o.resDown.magic : o.resDown.phys), resType: negPct(o.resDown.type),
          typeNE: pct(typeNet), wielder: pct(dmgNet), hawk: focusV ? [focusV * 100, 0] : [],
          weak: o.weakBuff ? [o.weakBuff * 100] : [], typeE: eq.equip.map(x => x * 100), statusE: [...eq.punishV, ...(sl.statusE || [])],
          enhance: sl.enhance, fallen: sl.fallen, condE: sl.condE, kesshi: sx.kesshi * 100 || undefined, shingan: sx.shingan * 100 || undefined,
          condNB: o.skillFx.map(x => x * 100), critDmg: pct(critDmg), overCrit: oc * 100 || undefined, aim: sum(sl.aim) || undefined,
          zoneAwake: sl.zoneAwake, lsAlly: sl.lsAlly, overthrowE: sl.overthrowE, growthAtk: sl.growthAtk, wins: (sl.wins || [])[0],
          zone: pct(o.zone), cheer: ev.groups.map(x => x * 100), aura: bud ? bud.aura.map(x => x * 100) : [], break: sx.brk * 100 || undefined } });
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
    { id: "type", label: "속성 공격 UP(공격 속성)" }, { id: "dmg", label: "가하는 대미지 UP(무기 포함)" },
    { id: "crit", label: "크리티컬율 UP", add: true }, { id: "critDmg", label: "크리티컬 대미지 UP", add: true },
    { id: "resType", label: "적 속성 저항 DOWN", enemy: true }, { id: "resPhys", label: "적 물리(마법) · 공격 종류 저항 DOWN", enemy: true },
    { id: "def", label: "적 내구(정신) DOWN", enemy: true },
    { id: "focus", label: "심기일체 · 정신 통일", flag: true }, { id: "overthrow", label: "하극상", flag: true },
    { id: "sureCrit", label: "크리티컬 확정", flag: true }, { id: "overcrit", label: "오버 크리티컬", flag: true },
    { id: "mindseye", label: "심안(루나틱)", flag: true }, { id: "risktaker", label: "결사(루나틱)", flag: true },
    { id: "break", label: "적 브레이크", flag: true, enemy: true },
  ];
  function presetValue(id, c, ctx) {
    const a = c.all, e = c.enemy, el = ctx.element, mg = !!ctx.magic, gn = b => (b.length ? C.groupNet({ buffs: b }) : 0);
    switch (id) {
      case "pwr": case "int": case "spd": return gn(a[id].buffs);
      case "type": return gn(el ? [...(a.type["*"] || []), ...(a.type[el] || [])] : (a.type["*"] || []));
      case "dmg": return gn([...a.dmg.buffs, ...(a.wdmg[ctx.weapon] || [])]);
      case "crit": return C.additive(mg ? a.mcrit : a.crit);
      case "critDmg": return C.additive(mg ? a.mcritDmg : a.critDmg);
      case "resType": return el ? gn([...(e.type["*"] || []), ...(e.type[el] || [])]) : 0;
      case "resPhys": return gn(mg ? e.magic : [...e.phys, ...(e.atk[ctx.atk] || [])]);
      case "def": return gn(mg ? e.mdef : e.def);
      case "focus": return (mg ? a.focusMag : a.focusPhys).length ? 1 : 0;
      case "overcrit": return (mg ? a.movercrit : a.overcrit) ? 1 : 0;
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
        case "type": pct(el ? el + " 속성 공격" : "모든 속성 공격", v); break;
        case "dmg": fx.push({ k: "dmg", dir: "UP", what: "가하는 대미지", value: +(v * 100).toFixed(2), tc: ally }); break;
        case "crit": pct(mg ? "마법 크리티컬율" : "크리티컬율", v); break;
        case "critDmg": pct(mg ? "마법 크리티컬 대미지" : "크리티컬 대미지", v); break;
        case "resType": if (el) pct(el + " 속성 저항", v, "DOWN", foe); break;
        case "resPhys": pct(mg ? "마법 저항" : "물리 저항", v, "DOWN", foe); break;
        case "def": pct(mg ? "정신" : "내구", v, "DOWN", foe); break;
        case "focus": fx.push({ k: "buff", name: mg ? "정신 통일" : "심기일체", tc: ally }); break;
        case "overthrow": fx.push({ k: "buff", name: "하극상", tc: ally }); break;
        case "sureCrit": fx.push({ k: "buff", name: "크리티컬 발생 확정", tc: ally }); break;
        case "overcrit": fx.push({ k: "buff", name: mg ? "마법 오버 크리티컬" : "오버 크리티컬", tc: ally }); break;
        case "mindseye": fx.push({ k: "buff", name: "심안", tc: ally }); break;
        case "risktaker": fx.push({ k: "buff", name: "결사", tc: ally }); break;
        case "break": fx.push({ k: "ailment", name: "브레이크", tc: foe }); break;
      }
    }
    return { c: { id: "_preset", nameKo: level === "max" ? "외부 버프(최대)" : "외부 버프(표준)", traits: [] }, fx, grasta: [], badges: [], preset: true };
  }
  const presetCtx = (atk, weapon) => ({ element: (atk && atk.element) || null, atk: (atk && atk.atk) || "", magic: !!atk && (atk.dep === "magic" || atk.dep === "magicpwr"), weapon: weapon || "" });

  const api = { allyGroups, enemyGroups, prepare, equipFor, envFor, statusOf, affinityOf, zoneMult, memberDamage, bestWeapon, posReq, contrib, buddyGroups,
    PRESET, presetStats, presetMember, presetCtx, envOk, whoOk };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AEParty = api;
})(typeof window !== "undefined" ? window : globalThis);
