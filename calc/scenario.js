// 파티 빌드 시나리오 실행기 (2026-10-17, plan ae-party-build E1) — 규칙 docs/ae-turn-sim.md §2.2~2.5
//   입력: 파티(전방 멤버 = party_calc 계산 멤버 + actions(data/calc/actions/<id>.json 한 문서) + slots(스킬 이름 4개)),
//         계획 plan = { af: [[멤버마다 스킬 이름 6개]] | null, turns: [[멤버마다 그 턴 스킬 이름]] }, opt(적 · 존 · 환경 · 버디 …)
//   진행: 전투 시작(패시브 · 전투 시작 효과) → (AF 면) T1 AF: 좌→우 순환 시전(점수 밖) → T1 턴 종료 → T2… 일반 턴(속도순 1회씩)
//   효과 타임라인: 시전자 × 효과(종류 · 스탯/이름 · 방향 · 편) 한 칸 — 다시 걸면 덮어쓰기, 최고 누적이면 겹 +1(값은 party_calc 가 반감 누적으로),
//     turns = 건 턴이 0턴, 그 턴 + N 턴 끝 만료(0 = 그 턴 끝) · times = 대미지 행동마다 1 소모(속성 공격 · 크리율) · 영구는 null
//   대미지: 공격 순간 살아 있는 효과를 시전자별 fx 로 묶어 party_calc.memberDamage(근사) — 정적 추정과 같은 식. 스킬의 효과는 공격 뒤에 건다
//   장비 「공격 시」 부여(D2, 10-17): 대미지 행동 뒤 적 저항 다운(확률 × 값) · 페인/독(확률 p). 대상 상태 = 살아 있는 적 페인 · 독(스킬 · 장비) + 화면 토글(opt.punish)
//     — 확률 p < 1 상태는 켠 값 · 끈 값을 p 로 섞는다. 적 상태 저항 · 확률 반복 누적은 안 본다
//   브라우저(window.AEScenario) · node 공용. 테스트: _tools/character/tests/test_scenario.cjs
(function (root) {
  "use strict";
  const P = root.AEParty || require("./party_calc.js");
  const T = root.AETerms || require("./concepts.js");   // 개념 레지스트리(효과 이름 → 개념 id)
  const C = root.AECalc || require("./ae_calc.js");
  const ENGINE = new Set(["stat_pct", "dmg", "buff", "ailment", "stack"]);

  // 행동 단위 공격 → party_calc 공격(1타 위력 · 타수 · dep)
  function toAttack(a, sk) {
    const magic = a.atk === "마법";
    const dep = a.dep === "pwr" && magic ? "magicpwr" : magic ? "magic" : a.dep === "int" ? "int" : a.dep === "spd" ? "spd" : "pwr";
    const mult = a.power ?? a.mult, multMax = a.powerMax ?? a.multMax;
    return { skill: sk.name, mult, multMax, hits: a.hits || 1, element: a.element || "", atk: a.atk || "", scope: a.scope || "", dep,
      conds: a.conds, mp: sk.mp || 0, sec: "skills", _sure: !!a.sureCrit, _fixed: !!a.fixed, _ignoreDef: !!a.ignoreDef, _burstMax: burstMax(sk) };
  }
  // 위값이 1회성 · 마무리에서 나오는 스킬(설명문, 11-05) — 「스텔라 버스트 시 위력 N배」 · 「스텔라 버스트로 발동한 횟수」 · 「대상 HP 비율이 낮을수록」.
  //   고점 반복(peak "repeat")에서 조건 칸이 빈 공격(딩님 원천)은 이때 위값 대신 기본값(셴화 테서렉트 ×60 = 대상 HP 낮을수록 — 반복 고점에 들어가 106억이 됐다)
  //   「스텔라 버스트 시」와 「공격 위력 N배」가 줄로 나뉜 꼴도(11-08 — 네코코 ES 유성군 ×40 · 조르나 · 셴화 AS 등 35스킬이 반복 고점에 SB 배율로 들어갔다)
  const BURST_MAX = /스텔라 버스트 시[^※\n]*\n?[^※\n]*?위력[^※\n]*?배|스텔라 버스트로 발동한 횟수|대상의 HP 비율이 낮을수록|target'?s? (?:current )?HP (?:percentage )?(?:is )?(?:lower|decreases)/i;
  const bmCache = new WeakMap();
  const burstMax = sk => { if (!bmCache.has(sk)) bmCache.set(sk, BURST_MAX.test(sk.desc || "")); return bmCache.get(sk); };
  const sideOf = u => (/적/.test(u.tc || "") ? "e" : "a");
  // 장비 효과는 스킬 효과와 따로 한 칸(출처가 다르면 덮어쓰지 않는다 — 위키 Buffs 「같은 시전자 × 출처」)
  const slotKey = (caster, u) => [caster, u.k, (u.stats || []).join(",") || u.name || u.what || "", u.dir || "", sideOf(u), u._equip ? "eq" : ""].join("|");

  // 장비 「공격 시」 부여 → 효과 단위(build_calc_db equip_fx k inflict). 지속 = 원문 N턴(없으면 3)
  const RES_KO = { slash: "베기 저항", pierce: "찌르기 저항", blunt: "타격 저항", physical: "물리 저항", magic: "마법 저항", type: "모든 속성 저항",
    fire: "불 속성 저항", water: "물 속성 저항", earth: "땅 속성 저항", wind: "바람 속성 저항", thunder: "번개 속성 저항", shade: "그림자 속성 저항", crystal: "결정 속성 저항" };
  function equipOnHit(m, opt) {
    const out = [];
    for (const it of [m.weapon, m.armor, ...(m.grasta || []), ...(m.badges || [])]) {
      if (!it) continue;
      const seen = new Set();
      for (const f of [...(it.fx || []), ...(it.calc || [])]) {
        if (f.k !== "inflict" || seen.has(f.what) || (f.env && !P.envOk(f.env, opt.env)) || (f.who && !P.whoOk(f.who, m.c))) continue;
        seen.add(f.what);
        const p = Math.min(1, (f.chance ?? 100) / 100), turns = f.turns ?? 3;
        if (/_res$/.test(f.what) && f.v && RES_KO[f.what.slice(0, -4)])
          out.push({ k: "stat_pct", stats: [RES_KO[f.what.slice(0, -4)]], dir: "DOWN", value: +(f.v * p).toFixed(2), tc: "적 하나", turns, _equip: it.name });
        else if (f.what === "pain" || f.what === "poison") out.push({ k: "ailment", name: f.what === "pain" ? "페인" : "독", tc: "적 하나", turns, p, _equip: it.name });
      }
    }
    return out;
  }
  // 적에게 건 페인 · 독(대상 상태) — 편이 비어 있으면 적(공격 스킬의 부가 효과). 맹독(Megapoison)도 독으로 센다 — 다르니스 AS 는 Venom Shot(맹독)으로 Triple Shot 「대상 독 시 ×5」를 켜는 키트(11-08)
  const TSTATE = { "독": "poison", "맹독": "poison", "페인": "pain" };   // 맹독 = 독의 강화판(대상 독 조건에 걸림, 11-08: 다르니스 AS 「Venom Shot」 맹독이 안 세져 독 조건 장비가 꺼져 있었다)
  const tstateOf = u => (u.k === "ailment" && TSTATE[u.name] && !/^(아군|자신|특정 아군)/.test(u.tc || "") ? TSTATE[u.name] : null);

  // 자원(구슬 — 낭지 · 무아 …, D3 뼈대 10-18): 캐릭터당 수치 하나. 상한 = 「구슬」 항목(sub 구슬)의 max, 양 = 「구슬 축적/소비」 단위 value(없으면 1).
  //   소비 스킬은 모자라면 그 행동이 없어진다(대미지 0). 조건부 소비(「이도신랑」으로 발동 시 …)는 평소 비용에서 뺀다
  const resMaxOf = m => { const r = (m.actions.skills || []).find(s => s.sub === "구슬" && s.max); return r ? r.max : Infinity; };
  //   연속 실행으로 불린 하위 스킬(via)은 부모가 비용을 낸다 — 자기 「X로 발동 시 소비」 단위만(해방 영랑지 SB → 이도신랑 EX 「낭지를 소비하지 않음」)
  const resCost = (sk, via) => (sk.fx || []).filter(u => u.k === "other" && u.name === "구슬 소비" && (via ? u.cond === `「${via}」로 발동 시` || u.cond === `[추가 효과] 「${via}」로 발동 시` : !u.cond))
    .reduce((s, u) => s + (u.value ?? 1), 0);
  // 일반 공격 · 변화한 일반 공격(사슬낫 공격 → 이도신랑 EX): 「구슬 N 이상 축적 시」(기본 1) 커맨드가 바뀐다 — 매 턴 고를 수 있는 행동(스킬칸 밖)
  const normalOf = m => (m.actions.skills || []).find(s => s.kind === "normal" && s.sub === "일반 공격");
  const transformOf = m => (m.actions.skills || []).find(s => s.kind === "normal" && s.sub === "변화한 일반 공격");
  const transformAt = m => { const n = normalOf(m), u = n && (n.fx || []).find(x => x.name === "스킬 변화"); const t = u && /(\d+) 이상 축적/.exec(u.cond || ""); return t ? +t[1] : 1; };
  // 고정 수치 스탯(힘 +100, flat) — % 가 아니라 스탯에 더한다(party_calc 는 % 만 받는다). 받는 쪽: 「자신」 = 시전자만, 그 밖 아군 편 = 전원
  const FLAT = { "힘": "pwr", "지능": "int", "속도": "spd", "행운": "lck" };
  function flatStats(sim, ci) {
    const add = {};
    for (const e of sim.live.values()) {
      if (!e.u.flat || e.u.k !== "stat_pct" || e.u.dir !== "UP" || sideOf(e.u) !== "a" || (/^자신/.test(e.u.tc || "") && e.ci !== ci)) continue;
      for (const st of e.u.stats || []) if (FLAT[st]) add[FLAT[st]] = (add[FLAT[st]] || 0) + (e.u.value || 0);
    }
    return add;
  }
  const withFlat = (m, fl) => (Object.keys(fl).length ? { ...m, stats: { ...m.stats, ...Object.fromEntries(Object.keys(fl).map(k => [k, ((m.stats || {})[k] || 0) + fl[k]])) } } : m);

  function newSim(party, opt, memo) {
    return { party, opt, memo, turn: 0, af: false, zone: opt.zone || null, live: new Map(), log: [], dmg: [], byMember: [], onHit: [], res: party.map(() => 0), used: new Map(), first: party.map(() => false),
      sb: { light: 0, shadow: 0, on: false, fired: 0 } };
  }
  // ── 스텔라 버스트(E3-3, 10-18 — 위키 Stellar Awakening §Building · §Flux, 사용자 「행동 수로 차고 어빌리티 · 공명으로 축적량이 다르며 발동 뒤 버프가 있다」) ──
  //   게이지 = 천 에너지 + 명 에너지(합 100%). 전투 시작: 전방 1명마다 자기 정렬에 12.5%(천명 255 가정) · 아군 행동(AF 시전 포함, 턴 종료 행동 · 버디 제외)마다 행동자 정렬에 2.5%
  //   + 천명 어빌리티(「축적량 N% UP」, need · cond). 100% 이상이면 다음 행동 경계에서 발동(버튼은 플레이어 몫 — 가장 이른 시점 가정): 전방 성도 각성 멤버(최대 4)가 스킬칸의 성도 스킬을 좌→우로
  //   턴 소비 없이 실행(「스텔라 버스트 시」 조건 켬, MP 는 안 셈) → 많은 쪽 에너지 = 플럭스 → 그쪽 「스텔라 버스트 강화」(timing sb) 발동 → 게이지 0. 공명(Resonance) 축적은 아직
  const ALIGN = { light: "light", shadow: "shadow", 천: "light", 명: "shadow" };
  const alignOf = m => ALIGN[(m.c && m.c.ls) || ""] || null;
  const isSA = m => (m.c && m.c.sa != null ? !!m.c.sa : (m.actions.skills || []).some(s => /^성도 스킬/.test(s.sub || "")));   // index sa 가 정본, 없으면 성도 스킬 보유로
  const stellarOf = m => (m.slots || []).map(n => (m.actions.skills || []).find(s => s.name === n)).find(s => s && /^성도 스킬/.test(s.sub || ""));
  function sbStart(sim) {
    if (!sim.party.some(isSA)) { sim.sb.off = true; return; }                  // 성도 각성 멤버가 없으면 게이지 자체가 없다
    for (const m of sim.party) { const a = alignOf(m); if (a) sim.sb[a] += 12.5; }
  }
  function sbGain(sim, ci) {
    if (sim.sb.off) return;
    const m = sim.party[ci], a = alignOf(m) || "light";
    let rate = 2.5;
    for (const sk of m.actions.skills || []) if (sk.kind === "ability")
      for (const u of sk.fx || []) if (u.k === "other" && /축적량 UP/.test(u.name || "") && (!u.cond || sim.opt.cond) && needOk(sim, ci, u.need)) rate += u.value || 0;
    sim.sb[a] += rate;
  }
  //   누르는 시점 = plan.sbAt(턴 번호 — 그 턴 시작에 누른다, 비AF 턴이면 턴을 안 쓰는 추가 행동) · 없으면 차는 즉시. 그 턴 전에 안 찼으면 찬 뒤 바로
  function sbFire(sim, scored, atTurnStart) {
    if (sim.sb.off || sim.sb.on || sim.sb.light + sim.sb.shadow < 100) return;
    const at = sim.plan && sim.plan.sbAt;
    if (at && !atTurnStart && sim.turn < at) return;                         // 미루는 중
    if (at && atTurnStart && sim.turn !== at && sim.turn < at) return;
    const flux = sim.sb.light >= sim.sb.shadow ? "light" : "shadow";
    sim.sb.on = true;
    let n = 0;
    sim.party.forEach((m, ci) => {
      const sk = isSA(m) && stellarOf(m);
      if (!sk || n >= 4) return;
      n++;
      act(sim, ci, sk.name, scored, undefined, 0, true);
    });
    sim.party.forEach((m, ci) => {                                           // 발동 뒤 버프 — 플럭스가 맞는 「스텔라 버스트 강화」
      for (const sk of m.actions.skills || []) if (sk.kind === "ability")
        for (const u of sk.fx || []) if (u.timing === "sb" && (!u.flux || u.flux === flux)) apply(sim, ci, { ...u, timing: undefined }, sk.name, sk);
    });
    sim.log.push({ turn: sim.turn, af: sim.af, sb: true, flux, who: n });
    sim.sb.light = sim.sb.shadow = 0; sim.sb.on = false; sim.sb.fired++;
  }
  // 효과 걸기 — 같은 칸은 덮어쓰기(누적형은 겹 +1), 지속 갱신
  // 파티 구성 조건(위키 need: 전방에 특성 n명 이상) — 실제 전방 멤버로 판정(others:false 면 본인 포함)
  function needOk(sim, ci, need) {
    if (!need) return true;
    const ts = need.traits || [];
    const cnt = sim.party.filter((m, i) => (need.others ? i !== ci : true) && ((m.c && m.c.traits) || []).some(t => ts.includes(t))).length;
    return cnt >= (need.n || 1);
  }
  // 스텝 조건(E3) — 「X 로 발동 시」 = 연속 실행 경로(via), 「X 로 발동하지 않았을 시」, 「X 습득 시」 = 그 스킬이 있으면 참(최대 빌드), 그 밖은 「조건부 효과 포함」(opt.cond)
  // 전방 구성 조건(11-08, hinaden 대조) — 「<결정> 아군 4명 시」 · 「When there are 2 or more Shadow party members on the front line」 처럼 전방 인원으로 판정할 수 있는 조건.
  //   전엔 opt.cond 하나로 전부 참이라, 번개 파티에서 알마 AS 의 「<결정> 아군 4명 시 극 휘정진」이 펴져 고점 존이 휘정진으로 바뀌었다(실전은 초뢰진).
  //   판정할 수 없는 꼴 · 모르는 꼬리표는 null(기존대로 opt.cond)
  const COMP_EN = { fire: "불", water: "물", earth: "땅", wind: "바람", thunder: "번개", shade: "그림자", crystal: "결정", sword: "검", fists: "권갑", fist: "권갑", staff: "지팡이", bow: "활", lance: "창", spear: "창", axe: "도끼", hammer: "망치", katana: "도" };
  const TRAIT_EN = new Map(T.slots("trait").map(v => [v.en.toLowerCase(), v.ko]));
  const ELK = new Set(T.slots("element").map(v => v.ko)), WPK = new Set(T.slots("weapon").map(v => v.ko));   // 속성 · 무기는 index 의 elementKo · 무기로 늘 안다
  const tagOk = (c, t) => (t === "천" ? c.ls === "light" : t === "명" ? c.ls === "shadow" : t === "light" ? c.ls === "light" : t === "shadow" ? c.ls === "shadow" : (c.traits || []).includes(t) || c.elementKo === t);
  function compOk(sim, cond) {
    if (!cond) return null;
    let x, tags, n;
    if ((x = /^(?:\[추가 효과\]\s*)?((?:<[^>]+>(?:,\s*또는,\s*)?)+)\s*아군 (\d+)명(?: 이상)? 시$/.exec(cond))) { tags = [...x[1].matchAll(/<([^>]+)>/g)].map(y => y[1]); n = +x[2]; }
    // 영어 꼴(11-08 넓힘): 「When 4 Arcadia characters are on the frontline」 · 「When 3 or more Ax characters …」 · 「Bow, Lance, or Arcadia party members」 —
    //   전엔 「party members」 · 무기 · 속성만 읽어 쿠치나와 AS 연계(아르카디아 4명 시 아군 전체 변화무쌍(땅))가 판정 없이 켜졌다. 성격은 레지스트리 어휘 trait(영어 → 한국어 traits)
    else if ((x = /^When (?:there are )?(\d+)(?:\+| or more)? (.+?) (?:characters|party members|allies)(?: are| is)? on the front ?line$/i.exec(cond))) {
      n = +x[1]; tags = x[2].split(/\s*,\s*(?:or\s+)?|\s+or\s+/).filter(Boolean).map(t => { const k = t.toLowerCase(); return COMP_EN[k] || (k === "light" || k === "shadow" ? k : (TRAIT_EN.get(k) || null)); });
      if (tags.some(t => !t)) return null;
    } else return null;
    const front = (sim.party || sim).filter(m => m.pos !== "back").slice(0, 4);
    // 성격 칸이 빈 캐릭터(index traits 없음)는 모름 — 확실히 맞는 수가 n 이상이면 참, 모름을 다 맞다 쳐도 n 미만이면 거짓, 그 사이는 판정 보류(null)
    const hit = front.filter(m => tags.some(t => tagOk(m.c || {}, t))).length;
    const unk = front.filter(m => !tags.some(t => tagOk(m.c || {}, t)) && !((m.c || {}).traits || []).length && tags.some(t => !ELK.has(t) && !WPK.has(t))).length;
    return hit >= n ? true : hit + unk < n ? false : null;
  }
  // 스킬 전체 발동 조건(설명 첫 줄 「전투 시작 시, <결정> 아군 2명 이상 시 발동」) — 빌더가 단위 cond 에 안 옮긴다(알마 AS 「(2)」 휘정진)
  const skillGate = sk => { const x = /(?:^|,\s*)((?:\[추가 효과\]\s*)?(?:<[^>]+>(?:,\s*또는,\s*)?)+\s*아군 \d+명(?: 이상)? 시) 발동/.exec(((sk && sk.desc) || "").split(/\r?\n/)[0]); return x ? x[1] : null; };
  const gateOk = (sim, sk) => compOk(sim, skillGate(sk)) !== false;
  // 존 조건(11-08) — 「When in Torn Earth Stance」 · 「(극 )각음진 시」 · 「ANOTHER ZONE 시」 · 「ZONE 시」 · 「When in Any Stance」. 지금 존(sim.zone)으로 판정, 존 말이 없으면 null.
  //   전엔 고점이 효과를 존보다 먼저 걸어 존 조건이 늘 켜졌다(각음진 조건 효과가 지열진 파티에서도 붙음)
  function zoneCond(sim, cond) {
    if (!cond || !Array.isArray(sim.party)) return null;
    const z = sim.zone, b = z && (z.base || z), zs = sim.opt.zones || [];
    const named = zs.find(x => (x.name && cond.includes(x.name)) || (x.ko && new RegExp(`(^|[^가-힣])${x.ko}`).test(cond)));
    if (named) return !!b && (b.name === named.name) && (!/극 |Awakened/i.test(cond) || !!z.awake);
    if (/ANOTHER ZONE 시|When in Another Zone|When in an Awakened|Radical/i.test(cond)) return !!(z && z.awake);
    if (/(^|\] )ZONE 시|When in Any Stance|Elemental\/Attack Type Zone|applicable Zone/i.test(cond)) return !!z;
    return null;
  }
  function condOk(sim, m, cond, via) {
    if (!cond || /^awakens any/i.test(cond)) return true;                 // 위키 「Another Zone」 본문(조건 아님, 11-05)
    if (sim.opt.peak === "repeat" && ONE_SHOT.test(cond)) return false;   // 반복 고점 — 1회성 스텝(전투 1회 · 첫 턴)은 끈다
    { const c = compOk(sim, cond); if (c !== null) return c; }
    if (zoneCond(sim, cond) === false) return false;
    if (/^스텔라 버스트 시$/.test(cond)) return !!sim.sb.on;                 // SB 안에서 실행 중일 때
    let x;
    if ((x = /^「(.+?)」로 발동 시$/.exec(cond))) return via === x[1];
    if ((x = /^「(.+?)」로 발동하지 않았을 시$/.exec(cond))) return via !== x[1];
    if ((x = /^「(.+?)」 습득 시$/.exec(cond))) return (m.actions.skills || []).some(s => s.name === x[1]);
    return !!sim.opt.cond;
  }
  // 「속성 ZONE에 따라 ANOTHER ZONE 전개 종류 변화」(네코코 ES) — 빌더는 7속성 「극 X」 전개로 펼치지만 실제는 지금 존을 각성(없으면 기본 「극 풍왕진」).
  //   전엔 번개 파티에서 고점이 「극 휘정진」을 골라 실전(초뢰진)과 어긋났다(11-08) → [추가 효과] 극 X 단위는 각성으로
  const normZone = (u, sk) => (u.k === "zone" && /^극 /.test(u.name || "") && /^\[추가 효과\]/.test(u.cond || "") && /ZONE에 따라 ANOTHER ZONE 전개 종류 변화/.test((sk && sk.desc) || "")) ? { ...u, k: "zoneAwake", name: "" } : u;
  // 크리티컬 원천 해석(11-08, hinaden 대조 — 요르나 · 흑의 검사 AS 가 크리 0 으로 계산돼 모든 칸에서 크리 장비를 +90% 로 추천):
  //   「구슬 축적 물리/마법 크리티컬율 UP」(딩님 원천 k other: 구슬 1개당 value%, 상한 max) = 지금 구슬 수 × value(고점 = 구슬 가득) ·
  //   「구슬 축적 결사」 = 구슬이 가득일 때 결사 · 위키 원천 「Guaranteed physical and magical critical」(루나틱 결사) = 결사 상태
  function normCrit(sim, ci, u) {
    if (u.k !== "other") return u;
    let x;
    if ((x = /^구슬 축적 (물리|마법) 크리티컬율 UP$/.exec(u.name || ""))) {
      const orbs = Math.min(sim.res[ci], resMaxOf(sim.party[ci]));
      const v = Math.min(u.max ?? Infinity, (+u.value || 0) * (Number.isFinite(orbs) ? orbs : 99));
      return { ...u, k: "stat_pct", dir: "UP", stats: [`${x[1]} 크리티컬율`], tc: "자신", value: v, name: undefined };
    }
    if (u.name === "구슬 축적 결사") return sim.res[ci] >= resMaxOf(sim.party[ci]) ? { ...u, k: "buff", name: T.ko("risktaker"), tc: "자신" } : u;
    if (/Guaranteed physical and magical critical/i.test(u.raw || "")) return { ...u, k: "buff", name: T.ko("risktaker"), tc: "자신", raw: undefined };
    return u;
  }
  // 변화무쌍(Kaleido, 11-08) — 걸린 아군의 모든 공격(일반 공격 포함) 속성을 지정 속성으로(용어집 kaleido). 전엔 엔진이 전혀 안 읽어,
  //   네코코 ES 「무녀의 악무」(속성 ZONE 따라 종류 변화)로 이스카 AS 샴발라를 땅으로 치는 hinaden 빌드가 그림자로 계산됐다.
  //   원천 꼴: 딩님 k other 「변화무쌍(X)」(tc) · 위키 k buff 「변화무쌍」 + raw 「Change element of … to Earth」 · zone 「Grants Kaleido … based on current deployed … zone」.
  //   한 스킬에 속성이 셋 이상(7속성 펼침) · 「ZONE에 따라 … 종류 변화」 · 「based on … zone」 = 지금 존의 속성("zone", 공격 때 푼다). 적에게 거는 것 · 대상 불명(한 명 지정)은 뺀다
  const ELS = T.slots("element").filter(v => !v.absent), KAL = T.ko("kaleido");
  const elOf = x => { x = String(x || "").trim(); const v = ELS.find(e => x === e.ko || x.toLowerCase() === e.en.toLowerCase()); return v ? v.ko : null; };
  const kalName = n => T.is(String(n || "").replace(/\(.*\)\s*$/, "").trim(), "kaleido");
  const KAL_IMMUNE = new RegExp(`${KAL}[^\\n]*적용 불가|will not change element by kaleido|not affected by kaleido`, "i");
  function kaleidoOf(u, sk) {
    const raw = u.raw || u.what || "";
    if (!(kalName(u.name) || /grants? kaleido/i.test(raw))) return null;
    const tc = u.tc || "", desc = (sk && sk.desc) || "";
    if (/^적/.test(tc) || /kaleido to all enemies/i.test(raw)) return null;
    const els = new Set(((sk && sk.fx) || []).filter(f => kalName(f.name)).map(f => elOf((/\(([^)]+)\)\s*$/.exec(f.name) || [])[1])).filter(Boolean));
    let el = els.size > 2 || new RegExp(`ZONE에 따라[^\\n]*${KAL}`).test(desc) || /based on current deployed/i.test(raw) ? "zone" : elOf((/\(([^)]+)\)\s*$/.exec(u.name || "") || [])[1]);
    if (!el) { const m = /change (?:the )?(?:element of [^;]*?|all party members |user (?:attacks )?)?to (\w+)/i.exec(raw); el = m ? (elOf(m[1]) || (/target/i.test(m[1]) ? "zone" : null)) : null; }
    if (!el) return null;
    let who = "self";
    if (/아군 전체|적과 아군/.test(tc) || /all party members/i.test(raw)) who = "all";
    else if (/^특정/.test(tc)) {
      if (/single party member|stacked ally/i.test(raw)) return null;
      who = /user/i.test(raw) ? "self" : "tag";
    }
    return { el, who };
  }
  function kalTargets(sim, ci, k, sk) {
    const n = sim.party.length;
    if (k.who === "self") return [ci];
    if (k.who === "all") return [...Array(n).keys()];
    // 「<명> 아군에게 / 변화무쌍(결정)」 · 「자신과 우측 <지팡이> 아군에게」 — 그 줄의 <태그>에 맞는 아군(+ 「자신」)
    const m = new RegExp(`([^\\n]*?)에게\\s*\\n[^\\n]*${KAL}`).exec((sk && sk.desc) || "");
    if (!m) return [ci];
    const tags = [...m[1].matchAll(/<([^>]+)>/g)].map(x => x[1]);
    const out = sim.party.map((x, i) => i).filter(i => tags.some(t => tagOk(sim.party[i].c || {}, t)));
    if (/자신/.test(m[1]) && !out.includes(ci)) out.push(ci);
    return out.length ? out : [ci];
  }
  // 임기응변(Flexible, 11-08) — 걸린 아군의 공격 종류(베기 · 찌르기 · 타격 · 마법)를 바꾼다(용어집 flexible). 변화무쌍과 같은 꼴:
  //   딩님 「임기응변(X)」(tc) · 위키 「grants Flexible (Piercing) to all party members」. 종류 넷 이상 펼침 · 「based on zone type」 = 지금 공격 종류 존의 종류.
  //   무기 · 대상 따라 바뀌는 것(「based on weapon type」 · 「target's weapon type」) · 적에게 거는 것은 뺀다
  const ATS = T.slots("attack_type"), FLEX = T.ko("flexible");
  const atOf = x => { x = String(x || "").trim().toLowerCase(); const v = ATS.find(e => x === e.ko || x === e.en.toLowerCase() || x === e.en.toLowerCase() + "ing" || (x === "piercing" && e.k === "pierce")); return v ? v.ko : null; };
  const flexName = n => T.is(String(n || "").replace(/\(.*\)\s*$/, "").trim(), "flexible");
  const FLEX_IMMUNE = new RegExp(`${FLEX}[^\\n]*적용 불가|will not change[^.\\n]*weapon type by flexible`, "i");
  function flexOf(u, sk) {
    const raw = u.raw || u.what || "";
    if (!(flexName(u.name) || /grants? flexible/i.test(raw))) return null;
    const tc = u.tc || "";
    if (/^적/.test(tc) || /weapon type|target's/i.test(raw)) return null;
    const ts = new Set(((sk && sk.fx) || []).filter(f => flexName(f.name)).map(f => atOf((/\(([^)]+)\)\s*$/.exec(f.name) || [])[1])).filter(Boolean));
    let at = ts.size > 2 || /based on zone type/i.test(raw) ? "zone" : atOf((/\(([^)]+)\)\s*$/.exec(u.name || "") || [])[1]);
    if (!at) { const m = /flexible \((\w+)\)/i.exec(raw); at = m ? atOf(m[1]) : null; }
    if (!at) return null;
    let who = "self", el = null;
    if (/아군 전체/.test(tc) || /all party members/i.test(raw)) who = "all";
    const em = /all (\w+) party members/i.exec(raw); if (em && elOf(em[1])) { who = "all"; el = elOf(em[1]); }
    return { at, who, el };
  }
  const ZBUF = /ZONE에 따라 '(?:속성 공격력 UP|버프와 디버프)' 종류 변화|type of buff changes according to active elemental zone/i;
  const zoneAt = sim => { const z = sim.zone && (sim.zone.base || sim.zone); return z && z.up ? (z.up.types || []).map(atOf).find(Boolean) || null : null; };
  const zoneEl = sim => { const z = sim.zone && (sim.zone.base || sim.zone); return z && z.up ? (z.up.types || []).map(elOf).find(Boolean) || null : null; };
  function apply(sim, ci, u, skName, sk) {
    u = normZone(u, sk);
    u = normCrit(sim, ci, u);
    // 위키 「Another Zone」 스킬 — 본문(「Awakens any … Zones」)이 cond 칸 · 설명 첫 줄에 있고 효과 단위는 안내 줄뿐 → 각성 단위로
    if (u.k === "zone" && !u.name && (/^awakens any/i.test(u.cond || "") || /^awakens any/i.test((sk && sk.desc) || ""))) u = { ...u, k: "zoneAwake", cond: undefined };
    // 「속성 ZONE에 따라 '속성 공격력 UP'(· '버프와 디버프') 종류 변화」(11-08) — 빌더는 7속성 단위로 펼친다(기본 속성 외엔 엉뚱한 조건이 붙기도) →
    //   지금 존의 속성 단위만 남기고 조건을 뗀다, 속성 존이 없으면 조건 없는 기본 단위만
    if (u.k === "stat_pct" && ZBUF.test((sk && sk.desc) || "")) { const ue = (u.stats || []).map(x => elOf((/^(\S+) 속성/.exec(x) || [])[1])).find(Boolean);
      if (ue) { const ze = zoneEl(sim); if (ze) { if (ue !== ze) return; u = { ...u, cond: undefined }; } else if (u.cond) return; } }
    if (u.cond && (!sim.opt.cond || compOk(sim, u.cond) === false || (u.k !== "zone" && u.k !== "zoneAwake" && zoneCond(sim, u.cond) === false))) return;
    if (sk && !gateOk(sim, sk)) return;
    if (!needOk(sim, ci, u.need)) return;
    { const f = flexOf(u, sk); if (f) { const until = u.turns == null ? Infinity : sim.turn + u.turns; for (const t of (f.who === "all" ? sim.party.map((x, i) => i) : [ci])) if (!f.el || ((sim.party[t].c || {}).elementKo === f.el)) sim.live.set(`flex|${t}`, { ci: t, u: { k: "flexible", at: f.at }, skill: skName, stacks: 1, until }); return; } }
    { const k = kaleidoOf(u, sk); if (k) { const until = u.turns == null ? Infinity : sim.turn + u.turns; for (const t of kalTargets(sim, ci, k, sk)) sim.live.set(`kal|${t}`, { ci: t, u: { k: "kaleido", el: k.el }, skill: skName, stacks: 1, until }); return; } }
    // 존 — 「극 X」 = ANOTHER ZONE(증가 효과 ×2, 2턴 뒤 존까지 사라짐) · 「절 X」 = Radical(×2, 5턴) · zoneAwake 단위 = 지금 존 각성(위키 Zones §Awakened, 구조 지도 §4.5). 그라스타 부여 존은 영어 이름
    if (u.k === "zone" || u.k === "zoneAwake") {
      // 위키 원천은 이름 없이 문구만 — 「Deploy X Stance」 = 존 전개, 「awaken Another Zone」 · Another Zone 스킬(조건 「Awakens any … Zones」) = 각성. 그 밖 안내 줄은 버린다(11-05: 전엔 이름만 봐서 위키 존 98개가 한 번도 안 펴졌다)
      if (u.k === "zone" && !u.name) {
        const d = /^Deploy (.+?)(?:\s*\(.*\))?\s*$/i.exec(u.what || "");
        if (d) u = { ...u, name: d[1] };
        else if (/^awaken another zone/i.test(u.what || "")) u = { ...u, k: "zoneAwake" };
        else return;
      }
      const aw = /^극 /.test(u.name || "") ? 2 : /^절 /.test(u.name || "") ? 5 : u.k === "zoneAwake" ? 2 : 0;
      const base = (u.name || "").replace(/^(극|절) /, "");
      const z = u.k === "zoneAwake" ? (sim.zone && (sim.zone.base || sim.zone)) : (sim.opt.zones || []).find(x => x.name === base || x.ko === base);   // zones.json ko = 용어집(terms) 한국어
      if (!z) return;
      sim.zone = aw ? { ...z, up: { ...z.up, v: (z.up.v || 0) * 2 }, awake: true, base: z, until: sim.turn + aw } : z;
      return;
    }
    if (u.k === "other" && u.name === "구슬 축적") { sim.res[ci] = Math.min(resMaxOf(sim.party[ci]), sim.res[ci] + (u.value ?? 1)); return; }
    if (u.k === "other" && T.is(u.name, "mode_change")) {
      // 모드(영랑 · 전심 …)의 상시 효과를 지속 턴만큼 건다 — 어느 모드인지는 시전 스킬 설명의 「모드 체인지(X)」, 없으면 하나뿐인 모드
      const modes = (sim.party[ci].actions.skills || []).filter(s => s.sub === "모드 체인지");
      const named = /모드 체인지\(([^)]+)\)/.exec((sk && sk.desc) || "");
      const mode = (named && modes.find(s => s.name === named[1])) || (modes.length === 1 ? modes[0] : null);
      if (mode) for (const f of mode.fx || []) apply(sim, ci, { ...f, timing: undefined, turns: u.turns ?? null, cond: undefined }, "모드: " + mode.name);
      return;
    }
    if (!ENGINE.has(u.k) && !(u.k === "other" && T.is(u.name, "multi_upgrade"))) return;   // 다단 강화 = 딩님 원천은 k other(상태 효과) — party_calc 가 상태로 읽는다(11-04)
    const key = slotKey(ci, u), old = sim.live.get(key);
    // 겹은 같은 스킬을 다시 걸 때만 오른다 — 다른 스킬이 같은 칸을 덮어쓰면 1부터(전에는 앞 스킬 겹을 이어받아 첫 시전이 2겹이 됐다)
    const stacks = u.maxStack > 1 ? Math.min(u.maxStack, (old && old.skill === skName ? old.stacks : 0) + 1) : 1;
    const until = u.turns == null ? (u.times ? Infinity : Infinity) : sim.turn + u.turns;    // 만료 = 그 턴 끝
    // 브레이크 축적(stack 엘리멘탈/웨폰 브레이크 「N 축적」)은 남은 개수 left — 일치 타마다 1개 소모(consumeBreak), 다시 걸면 더해진다
    const left = u.k === "stack" ? Math.max(1, Math.floor(u.value || 1)) + (old && old.left ? old.left : 0) : undefined;
    sim.live.set(key, { ci, u, skill: skName, stacks, until, times: u.times || null, left });
  }
  // 브레이크 소모 — 그 공격의 일치 타 수만큼(엘리멘탈 = 같은 속성, 웨폰 = 같은 공격 종류, 일반 = 아무 타). party_calc 는 fxOf 가 넘긴 남은 개수(value)로 첫 타들에 ×2
  function consumeBreak(sim, atk, hits) {
    for (const [k, e] of sim.live) {
      if (!e.left || sideOf(e.u) !== "e") continue;
      const st = P.statusOf(e.u);
      if (!st) continue;
      const fit = st.id === "elemental_break" ? st.which === atk.element : st.id === "weapon_break" ? (st.which || []).includes(atk.atk) : st.id === "break";
      if (!fit) continue;
      const n = Math.min(e.left, hits);
      hits -= n; e.left -= n;
      if (e.left <= 0) sim.live.delete(k);
      if (hits <= 0) break;
    }
  }
  // 살아 있는 효과 → 시전자별 fx(누적은 A + A/2·(n−1) 한 값)
  function fxOf(sim, ci, extra) {
    const out = [];
    for (const e of sim.live.values()) {
      if (e.ci !== ci || e.u.flat || e.u.k === "kaleido" || e.u.k === "flexible") continue;     // 고정 수치는 flatStats 가 스탯에 · 변화무쌍은 공격 속성(attackRaw)
      const v = e.left ? e.left : typeof e.u.value === "number" && e.stacks > 1 ? +C.halfStack(e.u.value, e.stacks).toFixed(2) : e.u.value;
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
      const live = [...sim.live.entries()].map(([k, e]) => `${k}#${e.stacks}#${e.left || e.u.value}`).sort().join(";");
      key = `${sim.gear}|${ci}|${sk.name}|${part.power ?? part.mult}x${part.hits || 1}${part.element || ""}${part.atk || ""}|${(sim.zone || {}).name || ""}${sim.zone && sim.zone.awake ? "!" : ""}|${sim.turn}|${sim.af ? 1 : 0}${sim.sb.on ? "S" : ""}|h${part._h0 || 0}${sim.first[ci] ? "F" : ""}|${live}`;
      if (memo.has(key)) return memo.get(key);
    }
    const v = attackRaw(sim, ci, sk, part);
    if (memo) memo.set(key, v);
    return v;
  }
  function attackRaw(sim, ci, sk, part) {
    const atk = toAttack(part, sk);
    if (/ZONE에 따라 공격 속성 변화/.test(sk.desc || "")) { const el = zoneEl(sim); if (el) atk.element = el; }   // 네코코 ES 유성군 · 적의 플람 얼터 등 14스킬(11-08)
    { const fl = sim.live.get(`flex|${ci}`); if (fl && !FLEX_IMMUNE.test(sk.desc || "")) { const at = fl.u.at === "zone" ? zoneAt(sim) : fl.u.at; if (at) atk.atk = at; } }   // 임기응변
    { const kl = sim.live.get(`kal|${ci}`); if (kl && !KAL_IMMUNE.test(sk.desc || "")) { const el = kl.u.el === "zone" ? zoneEl(sim) : kl.u.el; if (el) atk.element = el; } }   // 변화무쌍
    // 상태 효과 고정값(힘 · 지능 · 속도 +N) = 딩님 계산기 14~16행 — 공격력에는 더하고 (1 + 힘/32) 배율에는 안 넣는다 → party_calc flatFx(근사 stacks · 정밀 fx.flat).
    //   전에는 기본 스탯에 더해 배율까지 키웠다(영랑 모드 힘 +100 등, 11-04). 행운은 크리율에만 쓰여 스탯에 그대로
    const flatOf = i => { const { lck, ...fl } = flatStats(sim, i); return { m: lck ? withFlat(sim.party[i], { lck }) : sim.party[i], fl }; };
    const members = sim.party.map((m0, i) => { const { m, fl } = flatOf(i); return { ...m, flatFx: Object.keys(fl).length ? fl : null, fx: fxOf(sim, i, i === ci && atk._sure ? [{ k: "buff", name: "크리티컬 발생 확정", _skill: sk.name, _atkItem: true }] : null), _contrib: null }; });
    const m = { ...members[ci], attack: atk };
    members[ci] = m;
    // 대상 상태 — 확실한 것(p = 1 · 화면 토글)과 확률 상태(p < 1, 켠 값 · 끈 값을 p 로 섞음)
    const sure = new Set(sim.opt.punish || []), maybe = new Map();
    for (const e of sim.live.values()) {
      const s = tstateOf(e.u);
      if (!s || sure.has(s)) continue;
      const p = e.u.p ?? 1;
      if (p >= 1) { sure.add(s); maybe.delete(s); } else maybe.set(s, Math.max(maybe.get(s) || 0, p));
    }
    // breakOn: 시나리오가 건 브레이크 축적은 확정 사실(남은 개수 left 로 소모) — 정적 식의 「조건부일 때만」 기본값을 켠다
    const dmg = punish => { const r = P.memberDamage(m, members, { ...sim.opt, zone: sim.zone, zoneAwake: !!(sim.zone && sim.zone.awake), turns: sim.turn, af: sim.af, punish, breakOn: sim.opt.breakOn ?? true, lunatic: sim.opt.lunatic ?? true, normalAtk: sk.kind === "normal", hitOffset: part._h0 || 0, firstUse: !!sim.first[ci] }); return r ? r.perUse : 0; };
    const mb = [...maybe];
    let v = 0;
    for (let mask = 0; mask < 1 << mb.length; mask++) {
      let pr = 1;
      const on = [...sure];
      mb.forEach(([s, p], i) => { if (mask >> i & 1) { pr *= p; on.push(s); } else pr *= 1 - p; });
      v += pr * dmg(on);
    }
    return v;
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
  // 스킬 1회 = 스텝 순서대로(E3, docs/ae-battle-engine-audit.md §5) — fx: 그 순간 걸기 / atk: 분할이면 타마다(첫 타 뒤 그 공격의 상태 부여를 걸고 남은 타), 아니면 첫 타 상태로 타수 /
  //   exec: 하위 스킬을 그 자리에(via = 이 스킬) / next: 행동 경계(행동 소모형 버프는 공격 있는 행동마다 1) / repeat: 다음 스텝 n회. 스텝이 없는 스킬(옛 데이터)은 공격 전부 → 효과 전부
  function act(sim, ci, name, scored, via, depth = 0, inSB = false) {
    const m = sim.party[ci];
    let sk = (m.actions.skills || []).find(s => s.name === name);
    if (!sk || depth > 4) return 0;
    if (!depth && !inSB) { sbGain(sim, ci); }                                 // 행동 1회 = 게이지(스텔라 버스트 안 실행 · 하위 스킬은 제외)
    if (sk.sub === "일반 공격") { const t = transformOf(m); if (t && sim.res[ci] >= transformAt(m)) sk = t; }   // 구슬이 차 있으면 변화한 일반 공격으로
    const cost = resCost(sk, via);
    if (cost && sim.res[ci] < cost) { sim.log.push({ turn: sim.turn, af: sim.af, ci, who: m.c.nameKo, skill: sk.name, dmg: 0, skip: "자원 부족" }); return 0; }
    sim.res[ci] -= cost;
    if (!depth) { const k = `${ci}|${sk.name}`; sim.first[ci] = !sim.used.get(k); sim.used.set(k, (sim.used.get(k) || 0) + 1); }   // 「전투 1회 · 첫 사용」 조건(11-04)
    let d = 0, lastAtk = null, hadAtk = false;
    const onHit = () => { for (const u of sim.onHit[ci] || (sim.onHit[ci] = equipOnHit(m, sim.opt))) apply(sim, ci, u, "장비: " + u._equip); };   // 장비 「공격 시」
    let hitN = 0;                                                             // 다단 강화 — 이 행동(move)에서 이미 친 타수. 행동 경계에서 0(위키 Multipliers: 1 move 안 모든 부분 · 반복은 이어짐)
    const endAction = () => { if (hadAtk) { consume(sim, ci, lastAtk); onHit(); } hadAtk = false; hitN = 0; };
    const steps = sk.steps ? sk.steps.slice() : [...(sk.attacks || []).map((a, i) => ({ t: "atk", i, cond: a.cond })), ...(sk.fx || []).map((u, i) => ({ t: "fx", i, cond: u.cond }))];   // 복사 — 분할 처리가 done 표식을 찍는다
    const fxUnits = sk.fx || [];
    for (let k = 0; k < steps.length; k++) {
      const st = steps[k];
      if (!condOk(sim, m, st.cond, via)) continue;
      let reps = 1;
      if (st.t === "repeat") { reps = st.n || 1; k++; if (k >= steps.length) break; }
      const s2 = steps[k];
      if (!condOk(sim, m, s2.cond, via)) continue;
      for (let r = 0; r < reps; r++) {
        if (s2.t === "fx") { const u = fxUnits[s2.i]; if (u && (!u.timing || u.timing === "use")) apply(sim, ci, { ...u, cond: undefined }, sk.name, sk); }
        else if (s2.t === "atk") {
          const a = sk.attacks[s2.i]; if (!a) continue;
          const hits = a.hits || 1;
          hadAtk = true; lastAtk = a;
          // 타마다 다시 계산 — 첫 타 뒤 이 공격 줄의 상태 부여(바로 뒤 fx 스텝 중 적 대상 상태 · 축적)를 걸어 둘째 타부터 「대상 페인」 등을 받게.
          //   타 사이에 바뀌는 것(뒤따르는 상태 부여 · 소모되는 브레이크)이 없으면 한 번에(속도 — 타마다 부르면 4인 60초 → 300초)
          const follow = [];
          if (a.split && hits > 1) for (let j = k + 1; j < steps.length && steps[j].t === "fx"; j++) { const u = fxUnits[steps[j].i]; if (u && (u.k === "ailment" || u.k === "stack") && sideOf(u) === "e") follow.push(j); else break; }
          const brkLive = [...sim.live.values()].some(e => e.left && sideOf(e.u) === "e");
          if (a.split && hits > 1 && (follow.length || brkLive)) {
            for (let h = 0; h < hits; h++) {
              d += attack(sim, ci, sk, { ...a, hits: 1, _h0: hitN }); hitN++;
              consumeBreak(sim, a, 1);
              if (h === 0) for (const j of follow) { if (condOk(sim, m, steps[j].cond, via)) apply(sim, ci, { ...fxUnits[steps[j].i], cond: undefined }, sk.name, sk); steps[j] = { t: "done" }; }
            }
          } else { d += attack(sim, ci, sk, { ...a, _h0: hitN }); hitN += hits; consumeBreak(sim, a, hits); }
        }
        else if (s2.t === "exec" && s2.skill) { endAction(); for (let n = 0; n < (s2.n || 1); n++) d += act(sim, ci, s2.skill, scored, sk.name, depth + 1); }
        else if (s2.t === "next") endAction();
      }
    }
    endAction();
    if (!depth) sim.log.push({ turn: sim.turn, af: sim.af, ci, who: m.c.nameKo, skill: sk.name, dmg: Math.round(d), ...(inSB ? { sb: true } : {}) });
    if (scored && !depth) sim.dmg[sim.turn] = (sim.dmg[sim.turn] || 0) + d;
    if (scored && !depth) (sim.byMember[sim.turn] = sim.byMember[sim.turn] || [])[ci] = ((sim.byMember[sim.turn] || [])[ci] || 0) + d;
    if (!depth && !inSB) sbFire(sim, scored);                                // 행동 경계 — 게이지가 찼으면 스텔라 버스트
    return d;
  }
  // 턴 시작(③) · 턴 종료(⑭) 시점 효과 — 어빌리티 · 모드의 timing turnStart / turnEnd 단위(좌→우). hit · sb 는 아직(적 행동 · SB 모델 없음)
  function timed(sim, timing) {
    sim.party.forEach((m, ci) => {
      for (const sk of m.actions.skills || []) if (sk.kind === "ability" || sk.sub === "모드 체인지")
        for (const u of sk.fx || []) if (u.timing === timing) apply(sim, ci, u, sk.name, sk);
    });
  }
  // 그 턴 행동의 계층 — 선제(tier pre) → 보통 → 후공(post). 계층 안은 속도순(난수 없음 = 기대값)
  const tierOf = (m, name) => { let sk = (m.actions.skills || []).find(s => s.name === name); if (sk && sk.sub === "일반 공격") sk = transformOf(m) || sk; return (sk && sk.tier) || "mid"; };
  function endTurn(sim) {
    for (const [k, e] of sim.live) if (e.until <= sim.turn) sim.live.delete(k);
    if (sim.zone && sim.zone.awake && sim.zone.until <= sim.turn) sim.zone = null;   // 각성 존 종료 = 원래 존까지 사라진다(⑪)
  }
  function battleStart(sim) {
    sim.party.forEach((m, ci) => {
      for (const sk of m.actions.skills || [])
        if (sk.kind === "ability") for (const u of sk.fx || []) if (u.timing === "always" || u.timing === "battleStart" || !u.timing) apply(sim, ci, { ...u, turns: u.timing === "battleStart" ? u.turns : null }, sk.name, sk);
    });
  }
  // 속도순(선제 · 후공 상태는 다음 판) — 같은 속도는 좌→우
  const order = sim => sim.party.map((m, i) => i).sort((a, b) => ((sim.party[b].stats || {}).spd || 0) - ((sim.party[a].stats || {}).spd || 0) || a - b);

  // 시나리오 실행 → { perTurn: {턴: 대미지}, score, log }
  //   plan.af = 멤버마다 6개(없으면 AF 없음) · plan.turns = 턴마다 멤버별 스킬 · conf.scoreTurns = 점수에 넣는 턴(기본: AF 면 2~4, 아니면 계획의 모든 턴) · conf.memo = 대미지 메모(Map)
  function run(party, plan, opt, conf = {}) {
    const sim = newSim(party, opt, conf.memo || null);
    sim.plan = plan;
    // 메모 키의 장비 서명 — 장비 후보를 바꿔 가며 같은 메모를 써도 섞이지 않게
    if (sim.memo) sim.gear = party.map(m => [m.weapon && m.weapon.name, m.armor && m.armor.name, ...(m.grasta || []).map(g => g.name), "/", ...(m.badges || []).map(x => x.name)].join(",")).join("|")
      + "||" + (opt.back || []).map(b => (b.grasta || []).map(g => g.name).join(",")).join("|");      // 후열 셔틀 그라스타(공유)
    battleStart(sim);
    sbStart(sim);
    sim.turn = 1;
    let t0 = 1;
    if (plan.af) {
      timed(sim, "turnStart");
      sim.af = true;
      const n = Math.max(...plan.af.map(x => x.length));
      for (let k = 0; k < n; k++) party.forEach((m, ci) => { if (plan.af[ci] && plan.af[ci][k]) act(sim, ci, plan.af[ci][k], false); });
      sim.af = false;
      endTurn(sim);
      timed(sim, "turnEnd");
      t0 = 2;
    }
    (plan.turns || []).forEach((row, i) => {
      sim.turn = t0 + i;
      timed(sim, "turnStart");
      sbFire(sim, true, true);                                           // 미뤄 둔 스텔라 버스트는 턴 시작에(턴을 안 쓴다)
      for (const tier of ["pre", "mid", "post"])
        for (const ci of order(sim)) if (row[ci] && tierOf(party[ci], row[ci]) === tier) act(sim, ci, row[ci], true);
      endTurn(sim);                                                    // ⑪ 만료
      timed(sim, "turnEnd");                                           // ⑭ 턴 종료 효과(만료 뒤 — 1턴 효과가 다음 턴까지 산다)
    });
    const perTurn = Object.fromEntries(Object.entries(sim.dmg).map(([t, v]) => [t, v]));
    const want = conf.scoreTurns || Object.keys(perTurn).map(Number);
    const perMember = party.map((m, ci) => want.reduce((s, t) => s + ((sim.byMember[t] || [])[ci] || 0), 0));   // 멤버별 점수 몫(기회비용 나누기용)
    return { perTurn, perMember, score: want.reduce((s, t) => s + (perTurn[t] || 0), 0), log: sim.log, live: sim.live, zone: sim.zone, res: sim.res, sb: sim.sb };
  }

  // 고점 한 장면(2026-11-05, 사용자 「AF 에서 4개 다 칠 수 있으니 4개 다 활용 · 고점 기준 · 단순하게」) — 턴 · 지속 · 자원 · 순서를 안 본다.
  //   멤버마다 패시브(ability) + 스킬칸 4개의 효과 단위를 전부 최대 누적으로 걸고(같은 칸은 큰 값이 남게 작은 값부터), 장비 「공격 시」 부여도 걸린 것으로 둔다.
  //   존 = 파티가 펼 수 있는 존 중 점수가 가장 높은 것(+ 각성 단위가 있으면 각성). 그 상태에서 멤버마다 스킬칸 · 일반 공격 중 가장 센 것 1회 → 합.
  //   conf.mode "repeat"(기본, 반복 고점) = 1회성(첫 턴 · 첫 사용 · 전투 1회 · 스텔라 버스트 시점 효과)을 끔 / "burst" = 순간 최고점. 스텔라 버스트 기술 자체는 아직 안 넣는다(따로 다룰 것)
  const ONE_SHOT = /first turn|first time|once per battle|first \d+ turns|최초|첫 턴|전투 중 1회|1회 한정/i;
  function peak(party, opt, conf = {}) {
    const mode = conf.mode || "repeat";
    const o = { ...opt, cond: true, peak: mode, lunatic: true, breakOn: true, maxHp: true };
    const skip = u => mode === "repeat" && (u.timing === "sb" || ONE_SHOT.test(u.cond || ""));
    const units = party.map(m => {
      const out = [];
      for (const sk of m.actions.skills || []) if ((m.slots || []).includes(sk.name) || sk.kind === "ability")
        for (const u0 of sk.fx || []) { const u = normZone(u0, sk); if (!skip(u)) out.push({ u, sk }); }
      return out.sort((a, b) => (+a.u.value || 0) - (+b.u.value || 0));
    });
    const zseen = new Set(), zones = [null];
    for (const x of units.flatMap(l => l.filter(y => y.u.k === "zone"))) { const k = x.u.name || x.u.what || ""; if (!zseen.has(k)) { zseen.add(k); zones.push(x); } }
    const AWK = /^awakens? (another zone|any)/i;                         // 위키 원천 각성 — 「awaken Another Zone」 · Another Zone 스킬 본문(cond · 설명)
    const awake = units.some(l => l.some(({ u, sk }) => compOk(party, u.cond) !== false && gateOk(party, sk) && (u.k === "zoneAwake" || /^(극|절) /.test(u.name || "") || (u.k === "zone" && !u.name && (AWK.test(u.what || "") || AWK.test(u.cond || "") || AWK.test(sk.desc || ""))))));
    const sig = party.map(m => [m.weapon && m.weapon.name, m.armor && m.armor.name, ...(m.grasta || []).map(g => g.name), "/", ...(m.badges || []).map(x => x.name), "/", ...(m.slots || [])].join(",")).join("|");
    const build = z => {
      const sim = newSim(party, o, conf.memo || null);
      sim.gear = `P${mode}|${sig}`; sim.turn = 2; sim.res = party.map(() => Infinity);   // 자원은 찬 것으로(구슬 소비 · 변화한 일반 공격)
      // 존을 먼저 편다(11-08) — 존 조건 효과(zoneCond) · 존 따라 종류가 바뀌는 효과가 지금 존을 보게
      if (z) { apply(sim, 0, { ...z.u, turns: null }, z.sk.name, z.sk); if (awake && sim.zone && !sim.zone.awake) sim.zone = { ...sim.zone, up: { ...sim.zone.up, v: (sim.zone.up.v || 0) * 2 }, awake: true, base: sim.zone, until: Infinity }; }
      party.forEach((m, ci) => {
        for (const { u, sk } of units[ci]) {
          if (u.k === "zone" || u.k === "zoneAwake") continue;
          for (let k = 0; k < Math.max(1, u.maxStack || 1); k++) apply(sim, ci, { ...u, turns: null, times: null }, sk.name, sk);
        }
        // 고점 = 정상 상태 — 장비 「공격 시 X% 부여(3턴)」는 매 턴 굴리므로 걸려 있을 확률 1 − (1 − p)^3(11-08: 스카 스매시 50% → 0.875.
        //   한 번 굴린 p 그대로면 0.5 미만 상태가 「없음」으로 빠져, 페인 장비 11개를 낀 hinaden 파티가 페인 없이 계산됐다)
        for (const u of equipOnHit(m, o)) apply(sim, ci, { ...u, turns: null, ...(u.p != null && u.p < 1 ? { p: +(1 - (1 - u.p) ** 3).toFixed(3) } : {}) }, "장비: " + u._equip);
      });
      return sim;
    };
    // 장면 복사 — 효과 칸(live)만 얕게 베낀다(act 가 새 칸을 넣고 브레이크 남은 수를 깎는다)
    const fork = base => { const sim = { ...base, live: new Map([...base.live].map(([k, e]) => [k, { ...e }])), res: base.res.slice(), first: base.first.slice(), used: new Map(),
      dmg: [], byMember: [], log: [], onHit: [], sb: { ...base.sb } }; return sim; };
    // o.zoneOnly(11-08) = 허용 존 이름 목록(「Torn Earth (Stance)」) — 실전 장비(격진 · 진의 주문 · 존 광석)가 가리키는 존만 고른다(다른 존은 후보에서 뺀다, 존 없음은 남김).
    //   허용 존을 펼 스킬이 스킬칸에 없으면 존 없음이 되어, 스킬칸 탐색(optimizePeak)이 그 존 전개 스킬(진의 주문 부여 등)을 넣는 쪽으로 간다
    const zKey = s => (s || "").replace(/ Stance$/, "");
    const zOnly = (o.zoneOnly || []).map(zKey), zAllow = s => !zOnly.length || !s || zOnly.includes(zKey((s.base && s.base.name) || s.name));
    let top = null;
    for (const z of zones) {
      const base = build(z);
      if (!zAllow(base.zone)) continue;                                   // 허용 밖 존은 멤버 계산 전에 건너뛴다(결과 같음, 속도)
      // 멤버 · 후보마다 장면을 복사해 act 를 돌린다 — 연속 실행 · 반복 · 브레이크 소모가 그대로, 장면끼리 섞이지 않게
      const per = party.map((m, ci) => {
        let best = { d: 0, name: null };
        for (const n of [...(m.slots || []), (normalOf(m) || {}).name].filter(Boolean)) {
          if (!(m.actions.skills || []).some(s => s.name === n)) continue;
          const d = act(fork(base), ci, n, true);
          if (d > best.d) best = { d, name: n };
        }
        return best;
      });
      const score = per.reduce((s, x) => s + x.d, 0), cand = { score, perMember: per.map(x => x.d), attackOf: per.map(x => x.name), zone: base.zone, live: base.live };
      if (zAllow(base.zone) && (!top || score > top.score)) top = cand;
    }
    return top;
  }

  // 살아 있는 효과 → 멤버별 fx(빌드의 장비 단계가 정적 계산에 넣는다)
  const liveFx = (live, ci) => fxOf({ live }, ci);
  // 살아 있는 대상 상태(확률 0.5 이상) — 장비 단계의 정적 식에 opt.punish 로
  const liveStates = live => [...new Set([...live.values()].filter(e => tstateOf(e.u) && (e.u.p ?? 1) >= 0.5).map(e => tstateOf(e.u)))];
  const api = { run, peak, toAttack, liveFx, liveStates, normalOf };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AEScenario = api;
})(typeof window !== "undefined" ? window : globalThis);
