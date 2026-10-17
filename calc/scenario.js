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
  // 장비 효과는 스킬 효과와 따로 한 칸(출처가 다르면 덮어쓰지 않는다 — 위키 Buffs 「같은 시전자 × 출처」)
  const slotKey = (caster, u) => [caster, u.k, (u.stats || []).join(",") || u.name || u.what || "", u.dir || "", sideOf(u), u._equip ? "eq" : ""].join("|");

  // 장비 「공격 시」 부여 → 효과 단위(build_calc_db equip_fx k inflict). 지속 = 원문 N턴(없으면 3)
  const RES_KO = { slash: "베기 저항", pierce: "찌르기 저항", blunt: "타격 저항", physical: "물리 저항", magic: "마법 저항", type: "속성 저항",
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
  // 적에게 건 페인 · 독(대상 상태) — 편이 비어 있으면 적(공격 스킬의 부가 효과). 맹독(Megapoison)은 「독 대상」 조건에 드는지 몰라 뺀다
  const TSTATE = { "독": "poison", "페인": "pain" };
  const tstateOf = u => (u.k === "ailment" && TSTATE[u.name] && !/^(아군|자신|특정 아군)/.test(u.tc || "") ? TSTATE[u.name] : null);

  // 자원(구슬 — 낭지 · 무아 …, D3 뼈대 10-18): 캐릭터당 수치 하나. 상한 = 「구슬」 항목(sub 구슬)의 max, 양 = 「구슬 축적/소비」 단위 value(없으면 1).
  //   소비 스킬은 모자라면 그 행동이 없어진다(대미지 0). 조건부 소비(「이도신랑」으로 발동 시 …)는 평소 비용에서 뺀다
  const resMaxOf = m => { const r = (m.actions.skills || []).find(s => s.sub === "구슬" && s.max); return r ? r.max : Infinity; };
  const resCost = sk => (sk.fx || []).filter(u => u.k === "other" && u.name === "구슬 소비" && !u.cond).reduce((s, u) => s + (u.value ?? 1), 0);
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
    return { party, opt, memo, turn: 0, af: false, zone: opt.zone || null, live: new Map(), log: [], dmg: [], byMember: [], onHit: [], res: party.map(() => 0) };
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
  function condOk(sim, m, cond, via) {
    if (!cond) return true;
    let x;
    if ((x = /^「(.+?)」로 발동 시$/.exec(cond))) return via === x[1];
    if ((x = /^「(.+?)」로 발동하지 않았을 시$/.exec(cond))) return via !== x[1];
    if ((x = /^「(.+?)」 습득 시$/.exec(cond))) return (m.actions.skills || []).some(s => s.name === x[1]);
    return !!sim.opt.cond;
  }
  function apply(sim, ci, u, skName, sk) {
    if (u.cond && !sim.opt.cond) return;
    if (!needOk(sim, ci, u.need)) return;
    if (u.k === "zone") { const z = (sim.opt.zones || []).find(x => x.name === (ZONE_KO[u.name] || u.name)); if (z) sim.zone = z; return; }   // 그라스타 부여 존은 영어 이름
    if (u.k === "other" && u.name === "구슬 축적") { sim.res[ci] = Math.min(resMaxOf(sim.party[ci]), sim.res[ci] + (u.value ?? 1)); return; }
    if (u.k === "other" && u.name === "모드 체인지") {
      // 모드(영랑 · 전심 …)의 상시 효과를 지속 턴만큼 건다 — 어느 모드인지는 시전 스킬 설명의 「모드 체인지(X)」, 없으면 하나뿐인 모드
      const modes = (sim.party[ci].actions.skills || []).filter(s => s.sub === "모드 체인지");
      const named = /모드 체인지\(([^)]+)\)/.exec((sk && sk.desc) || "");
      const mode = (named && modes.find(s => s.name === named[1])) || (modes.length === 1 ? modes[0] : null);
      if (mode) for (const f of mode.fx || []) apply(sim, ci, { ...f, timing: undefined, turns: u.turns ?? null, cond: undefined }, "모드: " + mode.name);
      return;
    }
    if (!ENGINE.has(u.k)) return;
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
      const fit = st.id === "ebreak" ? st.which === atk.element : st.id === "wbreak" ? (st.which || []).includes(atk.atk) : st.id === "break";
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
      if (e.ci !== ci || e.u.flat) continue;                             // 고정 수치는 flatStats 가 스탯에
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
      key = `${sim.gear}|${ci}|${sk.name}|${part.power ?? part.mult}x${part.hits || 1}${part.element || ""}${part.atk || ""}|${(sim.zone || {}).name || ""}|${sim.turn}|${sim.af ? 1 : 0}|${live}`;
      if (memo.has(key)) return memo.get(key);
    }
    const v = attackRaw(sim, ci, sk, part);
    if (memo) memo.set(key, v);
    return v;
  }
  function attackRaw(sim, ci, sk, part) {
    const atk = toAttack(part, sk);
    const members = sim.party.map((m, i) => ({ ...withFlat(m, flatStats(sim, i)), fx: fxOf(sim, i, i === ci && atk._sure ? [{ k: "buff", name: "크리티컬 발생 확정", _skill: sk.name, _atkItem: true }] : null), _contrib: null }));
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
    const dmg = punish => { const r = P.memberDamage(m, members, { ...sim.opt, zone: sim.zone, turns: sim.turn, af: sim.af, punish, breakOn: sim.opt.breakOn ?? true }); return r ? r.perUse : 0; };
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
  function act(sim, ci, name, scored, via, depth = 0) {
    const m = sim.party[ci];
    let sk = (m.actions.skills || []).find(s => s.name === name);
    if (!sk || depth > 4) return 0;
    if (sk.sub === "일반 공격") { const t = transformOf(m); if (t && sim.res[ci] >= transformAt(m)) sk = t; }   // 구슬이 차 있으면 변화한 일반 공격으로
    const cost = resCost(sk);
    if (cost && sim.res[ci] < cost) { sim.log.push({ turn: sim.turn, af: sim.af, ci, who: m.c.nameKo, skill: sk.name, dmg: 0, skip: "자원 부족" }); return 0; }
    sim.res[ci] -= cost;
    let d = 0, lastAtk = null, hadAtk = false;
    const onHit = () => { for (const u of sim.onHit[ci] || (sim.onHit[ci] = equipOnHit(m, sim.opt))) apply(sim, ci, u, "장비: " + u._equip); };   // 장비 「공격 시」
    const endAction = () => { if (hadAtk) { consume(sim, ci, lastAtk); onHit(); } hadAtk = false; };
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
              d += attack(sim, ci, sk, { ...a, hits: 1 });
              consumeBreak(sim, a, 1);
              if (h === 0) for (const j of follow) { if (condOk(sim, m, steps[j].cond, via)) apply(sim, ci, { ...fxUnits[steps[j].i], cond: undefined }, sk.name, sk); steps[j] = { t: "done" }; }
            }
          } else { d += attack(sim, ci, sk, a); consumeBreak(sim, a, hits); }
        }
        else if (s2.t === "exec" && s2.skill) { endAction(); for (let n = 0; n < (s2.n || 1); n++) d += act(sim, ci, s2.skill, scored, sk.name, depth + 1); }
        else if (s2.t === "next") endAction();
      }
    }
    endAction();
    if (!depth) sim.log.push({ turn: sim.turn, af: sim.af, ci, who: m.c.nameKo, skill: sk.name, dmg: Math.round(d) });
    if (scored && !depth) sim.dmg[sim.turn] = (sim.dmg[sim.turn] || 0) + d;
    if (scored && !depth) (sim.byMember[sim.turn] = sim.byMember[sim.turn] || [])[ci] = ((sim.byMember[sim.turn] || [])[ci] || 0) + d;
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
    // 메모 키의 장비 서명 — 장비 후보를 바꿔 가며 같은 메모를 써도 섞이지 않게
    if (sim.memo) sim.gear = party.map(m => [m.weapon && m.weapon.name, m.armor && m.armor.name, ...(m.grasta || []).map(g => g.name), "/", ...(m.badges || []).map(x => x.name)].join(",")).join("|");
    battleStart(sim);
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
      for (const tier of ["pre", "mid", "post"])
        for (const ci of order(sim)) if (row[ci] && tierOf(party[ci], row[ci]) === tier) act(sim, ci, row[ci], true);
      endTurn(sim);                                                    // ⑪ 만료
      timed(sim, "turnEnd");                                           // ⑭ 턴 종료 효과(만료 뒤 — 1턴 효과가 다음 턴까지 산다)
    });
    const perTurn = Object.fromEntries(Object.entries(sim.dmg).map(([t, v]) => [t, v]));
    const want = conf.scoreTurns || Object.keys(perTurn).map(Number);
    const perMember = party.map((m, ci) => want.reduce((s, t) => s + ((sim.byMember[t] || [])[ci] || 0), 0));   // 멤버별 점수 몫(기회비용 나누기용)
    return { perTurn, perMember, score: want.reduce((s, t) => s + (perTurn[t] || 0), 0), log: sim.log, live: sim.live, zone: sim.zone, res: sim.res };
  }

  // 살아 있는 효과 → 멤버별 fx(빌드의 장비 단계가 정적 계산에 넣는다)
  const liveFx = (live, ci) => fxOf({ live }, ci);
  // 살아 있는 대상 상태(확률 0.5 이상) — 장비 단계의 정적 식에 opt.punish 로
  const liveStates = live => [...new Set([...live.values()].filter(e => tstateOf(e.u) && (e.u.p ?? 1) >= 0.5).map(e => tstateOf(e.u)))];
  const api = { run, toAttack, liveFx, liveStates, normalOf, ZONE_KO };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AEScenario = api;
})(typeof window !== "undefined" ? window : globalThis);
