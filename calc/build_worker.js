// 파티 빌드 워커(2026-10-17, plan ae-party-build U1) — AEBuild.optimize 는 실제 4인 수십 초라 화면 스레드에서 돌리면 멈춘다
//   받는 것: { team(계산 멤버 + actions), opt, mode: "peak" | "sim" | "seq"(seq = [[멤버 번호, 스킬], …]), gear: bool, gearConf, db: {weapons, armor, grasta, badges, ores}, inv: 보유 목록 | null,
//             conf: 탐색 설정(고점 방식의 주력 지정 — pin · focus · carryStarts, 없으면 기본) }
//   보내는 것: { tick: 진행 문구 } … { done: 결과(멤버 객체 대신 장비만) } | { error }
importScripts("ae_calc.js", "concepts.js", "ae_pipeline.js", "party_calc.js", "optimizer.js", "scenario.js", "planner.js", "build.js");
// 파티원 추천(11-12) — { mode: "recommend", team: 고정 멤버, cands: [{ c, cc }](행동 단위는 여기서 받는다), opt, grasta: bool, db, conf: { open, focus } } → { done: { combos } }
//   후보 멤버 = 화면 teamMember 와 같은 꼴(기본 무기 · 주력 공격 · 장비 없음)
// 행동 단위 받기 — 실패하면 3번까지 다시(11-12: 24개씩 동시 요청에서 로컬 서버가 11개를 놓쳐 애쉬티어가 후보에서 조용히 빠졌다 → 추천 1위가 334억 → 75억 조합으로 바뀜)
async function getAct(id) {
  for (let t = 0; t < 4; t++) {
    try { const r = await fetch(`../data/calc/actions/${id}.json`); if (r.ok) return await r.json(); if (r.status === 404) return null; } catch {}
    await new Promise(ok => setTimeout(ok, 300 * (t + 1)));
  }
  return null;
}
async function recommend(d) {
  const tick = msg => postMessage({ tick: msg });
  const acts = new Array(d.cands.length);
  let got = 0;
  for (let i = 0; i < d.cands.length; i += 24) {                               // 24개씩 받기(376개 · 5.5MB)
    await Promise.all(d.cands.slice(i, i + 24).map((x, k) => getAct(x.c.id).then(a => { acts[i + k] = a; got++; })));
    tick(`후보 스킬 받기 ${got}/${d.cands.length}`);
  }
  const cands = d.cands.map((x, i) => {
    if (!acts[i]) return null;
    const atks = (x.cc.attacks || []).filter(a => a.mult || a.multMax), attack = AEOpt.attackPool(atks, false)[0] || atks[0];
    return { c: x.c, cc: x.cc, pos: "front", fx: [], atks, attack, weapon: AEParty.bestWeapon(d.db.weapons, x.cc.weapon, attack && attack.dep === "magic"), armor: null, special: [], grasta: [], badges: [], stats: x.cc.stats, zones: x.cc.zones || [], actions: acts[i], lock: [] };
  }).filter(Boolean);
  const missing = d.cands.filter((x, i) => !acts[i]).map(x => x.c.nameKo);                   // 받지 못한 후보 — 화면에 알린다(조용히 빼지 않는다)
  return { ...AEBuild.recommend(d.team, cands, d.opt, { ...(d.conf || {}), ...(d.grasta ? gearOf(d.db) : {}), tick }), missing };
}
// 추천 그라스타 단계 장비 후보 — 무기 = 지금 무기(기본 최강) 고정, 방어구 · 배지 없음, 그라스타(특수 칸 · 광석 조합 포함)만. 조합당 노드 ≈17초 · 브라우저 ≈44초.
//   광석을 빼면 3.2초지만 REJECTED(11-12): 광석 없는 그라스타 = 잠재 연성 최대로 세서 「물의 재앙 타격 ×2」 같은 세팅이 뽑혔다 — 사용자 「통증의 힘 + 아무 광석만 해도 저거보다 세다」
function gearOf(db) {
  const cache = new Map();
  const poolsOf = m => cache.get(m.c.id) || cache.set(m.c.id, { ...AEOpt.ownedPools(db, m.cc, m.c.traits, null).pools, weapons: [m.weapon].filter(Boolean), armor: [], badges: [] }).get(m.c.id);
  return { gear: { poolsOf, conf: { grastaSlots: 4, badgeSlots: 0, counts: null } }, grantsOf: m => poolsOf(m).grasta.filter(g => g.grant && !g.ore) };
}
onmessage = async ({ data: d }) => {
  try {
    if (d.mode === "recommend") return postMessage({ done: await recommend(d) });
    // 추천 조합 하나 마무리 — { mode: "recfin", team(조합 멤버 + slots · 고정 멤버 lock), opt, focus, grasta: bool, acts: 행동 수 | null, db }
    //   → { done: { q(최종), qPeak(그라스타 뒤 고점), perMember, grasta, turns } } · 화면이 조합마다 워커 하나씩 동시에. 순서 = 그라스타(고점으로) → 행동 수
    if (d.mode === "recfin") {
      let team = d.team;
      const out = {};
      if (d.grasta) {
        const g = AEBuild.gearCombo(team, d.opt, { focus: d.focus, ...gearOf(d.db) });
        team = g.team;
        Object.assign(out, { q: g.q, qPeak: g.q, perMember: g.perMember, grasta: team.map(m => (m.grasta || []).filter(Boolean).map(x => x.name)) });
      }
      if (d.acts) {
        const a = AEBuild.actCombo(team, d.opt, { acts: d.acts, focus: d.focus });
        Object.assign(out, { q: a.q, perMember: a.perMember, turns: a.turns });
      }
      return postMessage({ done: out });
    }
    const conf = { ...(d.conf || {}), tick: msg => postMessage({ tick: msg }) };
    if (d.gear) {
      const cache = new Map();
      conf.gear = { poolsOf: m => cache.get(m.c.id) || cache.set(m.c.id, AEOpt.ownedPools(d.db, m.cc, m.c.traits, d.inv).pools).get(m.c.id), conf: d.gearConf || {} };
      conf.grantsOf = m => conf.gear.poolsOf(m).grasta.filter(g => g.grant && !g.ore);     // 장비 최적화면 낄 수 있는 그라스타의 부여 스킬 전부
    }
    const r = d.mode === "peak" ? AEBuild.optimizePeak(d.team, d.opt, conf) : d.mode === "seq" ? AEBuild.optimizeSeq(d.team, d.seq, d.opt, conf) : AEBuild.optimize(d.team, d.opt, conf);   // 고점 빌드(11-05 기본) · 순서 빌드(11-12) · 턴 시뮬
    const { team, ...rest } = r;
    postMessage({ done: { ...rest, gear: team.map(m => ({ weapon: m.weapon || null, armor: m.armor || null, grasta: m.grasta || [], badges: m.badges || [], special: m.special || [] })) } });
  } catch (e) {
    postMessage({ error: String((e && e.stack) || e) });
  }
};
