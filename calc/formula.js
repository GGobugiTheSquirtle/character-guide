// 계산식 서명 (2026-11-11, 사용자 「가장 센 공격은 애매 — 같은 계산식이면 배율은 순위에 의미 없다. 가진 스킬의 계산식별로 빌드 · 스킬은 선택 가능하게」)
//   스킬 → 「장비 최적화 문제가 같은 묶음」의 키. 화면(파티 빌드의 주력 선택)과 러너(_tools/character/run_formula_builds.cjs)가 같이 쓴다 — 정본은 여기 한 곳
//   const F = AEFormula.make({ weapons, team });  F.sigOf(m, sk) · F.powerOf(m, sk) · F.mains(m, 스킬칸 후보 이름들) · F.groups(목록)
//
//   연역(사용자 「귀납 말고 연역으로 코드화」) — 정밀 공식(ae_pipeline.js)에서 1타 = f(위력 × G). G = 장비 · 상태가 만드는 곱,
//   f = 25억 경감: 기울기 1 → 0.3 → 0.1 → 0.03 → 0.01 → 0 인 이어진 꺾은선 = 단조 증가 · 오목 · f(x) ≤ x.
//   위력 · 범위(단일 ×1.1) · 고점에서 늘 켜지는 조건 배수는 G 밖의 상수 c  ⇒  경감을 끄면 스킬의 목표 = c × H(장비), H = p·G크리 + (1−p)·G비크리.
//   ① 서명(G 가 읽는 것)이 같은 스킬은 경감을 끈 최적화 문제가 같다(목표가 비례) — 배율은 순위에 안 닿는다
//   ② 그 최적 ĝ 에서 경감 켠 값 = 끈 값인 스킬은 ĝ 가 실제 최적 — 다른 장비 g 는 f(x) ≤ x 라 c·H(g) 를 못 넘고 c·H(g) ≤ c·H(ĝ)
//   ③ 경감 구간이어도 ĝ 에서 크리 확률이 0 · 1 로 고정이면 ĝ 가 실제 최적 — 타가 한 값이라 f(c·H(ĝ)) 이고, 다른 장비는 f 가 오목이라(젠센 부등식)
//      p·f(c·G크리) + (1−p)·f(c·G비크리) ≤ f(c·H(g)) ≤ f(c·H(ĝ))
//   ④ 순위가 바뀔 수 있는 건 「경감 구간 + 크리 혼합」뿐 — 오목한 경감은 평균이 같으면 크리 · 비크리 편차가 작은 장비를 고른다. 이때만 배율이 순위에 닿는다
//   ⑤ 타수는 브레이크(앞 n타 ×2) · 다단 강화(n번째 타 위력 ×1 · 1.25 · 1.5 · 2 · 3) · 연격 수 UP(첫 공격 부분에 1타 더)이 있을 때만 값을 바꾼다
//      — 파티에 그런 부여 스킬이 있으면 타수를 서명에 넣는다(hitsMatter)
//   ⑥ 위력에 비례하지 않는 더하기 항(턴 종료 · 반격 공격, 걸린 연계의 추가 공격)은 서명 밖 — 주력이 약할수록 장비가 그쪽으로 기운다(호출 쪽이 따로 적는다)
//   서명 = 부분마다 의존 스탯 · 공격 종류 · 속성 · 확정 크리 · 고정 · 방어 무시 · 장비/파티가 켜고 끄는 조건 배수(대상 상태 · 존 · 크리 전용) · 스텝 조건 · 이름 지정 무기 보정 (· 타수).
//     부분 서명이 둘 이상이면 부분 비중(위력 × 타수, 1% 단위)까지. 하위 스킬 실행(exec) · 반복은 펼친다
//   글자: 개념이 용어 레지스트리에 있으면 T.ko(id), 공격 종류 · 속성 · 조건은 데이터의 글자 그대로. 아래 W 는 서명의 표시 낱말(효과 판정에 안 쓴다) —
//     「방어 무시」 · 「고정 대미지」는 레지스트리에 개념이 없어 여기 낱말로만 둔다(생기면 T.ko 로 바꿀 것)
(function (root) {
  const S = root.AEScenario || require("./scenario.js");
  const T = root.AETerms || require("./concepts.js");
  const STAT = { pwr: "pwr", magicpwr: "pwr", magic: "int", int: "int", spd: "spd" };   // 의존 스탯 → 개념 id (마법 · 물리는 공격 종류 칸이 가른다)
  const W = { none: "무", hits: "타", fixed: "고정 대미지", ignoreDef: "방어 무시", cond: "조건", critOnly: "크리티컬 시", step: "스텝 조건", skillmod: "무기 보정" };
  const HIT_IDS = new Set(["break", "elemental_break", "weapon_break", "multi_upgrade", "skill_hits"]);
  const hitState = u => {
    const n = String(u.name || ""), b = (n.match(/^(.+?)\(/) || [])[1];
    return HIT_IDS.has(T.cid(n)) || (!!b && HIT_IDS.has(T.cid(b))) || (u.stats || []).some(x => HIT_IDS.has(T.cid(x))) || /skill hit count \+1/i.test(u.raw || "");
  };
  // 장비 · 파티가 켜고 끄는 조건 배수만 서명에 — 늘 켜지는 조건(고점 가정)은 상수라 뺀다
  const GEAR_COND = c => c.t === "target" || c.t === "zone" || c.t === "crit" || (c.t === "other" && /enemy has pain/i.test(c.label || ""));

  // weapons = 계산 DB 무기(이름 지정 스킬 보정 fx.k === "skillmod") · team = 전방 멤버([{ actions }] — 타수가 서명에 드는지 판정)
  function make({ weapons = [], team = [] } = {}) {
    const hitsMatter = team.some(m => (((m && m.actions) || {}).skills || []).some(sk => (sk.fx || []).some(hitState)));
    const skillmod = new Set(weapons.flatMap(w => (w.fx || []).filter(f => f.k === "skillmod" && f.total).map(f => f.skill)));
    // 스킬 → 공격 부분 [{ t: party_calc 공격, w: 반복 수, cond: 스텝 조건 }]
    function partsOf(m, sk, w = 1, depth = 0, out = []) {
      const steps = sk.steps || (sk.attacks || []).map((a, i) => ({ t: "atk", i, cond: a.cond }));
      let n = 1;
      for (const st of steps) {
        if (st.t === "repeat") { n = st.n || 1; continue; }
        if (st.t === "atk" && (sk.attacks || [])[st.i]) out.push({ t: S.toAttack(sk.attacks[st.i], sk), w: w * n, cond: st.cond || "" });
        else if (st.t === "exec" && st.skill && depth < 4) { const s2 = (m.actions.skills || []).find(x => x.name === st.skill); if (s2) partsOf(m, s2, w * n * (st.n || 1), depth + 1, out); }
        n = 1;
      }
      return out;
    }
    const partKey = ({ t, cond, w }) => [T.ko(STAT[t.dep] || t.dep), t.atk || "?", t.element || W.none, hitsMatter && `${t.hits || 1}${W.hits}${w > 1 ? "×" + w : ""}`,
      t._sure && T.ko("sure_crit"), t._fixed && W.fixed, t._ignoreDef && W.ignoreDef,
      ...(t.conds || []).filter(GEAR_COND).map(c => `${W.cond} ${c.t === "crit" ? W.critOnly : c.on || c.label} ×${c.x}`).sort(),
      cond && `${W.step} ${cond}`, skillmod.has(t.skill) && `${W.skillmod} ${t.skill}`].filter(Boolean).join("·");
    const weightOf = p => p.w * (p.t.multMax || p.t.mult || 0) * (p.t.hits || 1);
    function sigOf(m, sk) {
      const w = new Map();
      for (const p of partsOf(m, sk)) { const k = partKey(p); w.set(k, (w.get(k) || 0) + weightOf(p)); }
      const tot = [...w.values()].reduce((a, b) => a + b, 0) || 1;
      return [...w.entries()].sort().map(([k, v]) => (w.size > 1 ? `${k} ${Math.round(v / tot * 100)}%` : k)).join(" + ");
    }
    const powerOf = (m, sk) => partsOf(m, sk).reduce((s, p) => s + weightOf(p), 0);   // 계수 = 위력 × 타수 합(위값 기준)
    // 주력으로 고를 수 있는 공격 스킬 — 스킬칸에 넣을 수 있거나(slotable = 스킬칸 후보 이름들) 기본기 · 바뀐 스킬(스킬칸에 넣는 이름 = from)
    //   → [{ sk, slot: 스킬칸에 넣을 이름 | null, sig, power }]
    function mains(m, slotable) {
      const has = new Set(slotable), out = [];
      for (const sk of m.actions.skills || []) {
        if (!(sk.attacks || []).length || sk.kind === "normal") continue;
        const slot = sk.kind === "variant" ? sk.from : sk.name;
        if (!(has.has(slot) || sk.role === "basic" || sk.kind === "variant")) continue;
        const power = powerOf(m, sk);
        if (power > 0) out.push({ sk, slot: has.has(slot) ? slot : null, sig: sigOf(m, sk), power });   // 위력이 데이터에 없는 공격(위키 원천 일부)은 값이 0 이라 뺀다
      }
      return out;
    }
    // 서명별 묶음 — 묶음 안 · 묶음끼리 by(기본 = 계수) 큰 순
    function groups(list, by = x => x.power) {
      const g = new Map();
      for (const x of list) (g.get(x.sig) || g.set(x.sig, []).get(x.sig)).push(x);
      return [...g.entries()].map(([sig, l]) => ({ sig, list: l.sort((a, b) => by(b) - by(a)) })).sort((a, b) => by(b.list[0]) - by(a.list[0]));
    }
    return { hitsMatter, partsOf, sigOf, powerOf, mains, groups };
  }

  const api = { make, hitState };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.AEFormula = api;
})(typeof self !== "undefined" ? self : globalThis);
