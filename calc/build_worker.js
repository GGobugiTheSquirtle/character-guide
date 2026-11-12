// 파티 빌드 워커(2026-10-17, plan ae-party-build U1) — AEBuild.optimize 는 실제 4인 수십 초라 화면 스레드에서 돌리면 멈춘다
//   받는 것: { team(계산 멤버 + actions), opt, mode: "peak" | "sim" | "seq"(seq = [[멤버 번호, 스킬], …]), gear: bool, gearConf, db: {weapons, armor, grasta, badges, ores}, inv: 보유 목록 | null,
//             conf: 탐색 설정(고점 방식의 주력 지정 — pin · focus · carryStarts, 없으면 기본) }
//   보내는 것: { tick: 진행 문구 } … { done: 결과(멤버 객체 대신 장비만) } | { error }
importScripts("ae_calc.js", "concepts.js", "ae_pipeline.js", "party_calc.js", "optimizer.js", "scenario.js", "planner.js", "build.js");
// 파티원 추천(11-12) — { mode: "recommend", team: 고정 멤버, cands: [{ c, cc }](행동 단위는 여기서 받는다), opt, conf: { open, focus } } → { done: { combos } }
//   후보 멤버 = 화면 teamMember 와 같은 꼴(기본 무기 · 주력 공격 · 장비 없음)
async function recommend(d) {
  const tick = msg => postMessage({ tick: msg });
  const acts = new Array(d.cands.length);
  let got = 0;
  for (let i = 0; i < d.cands.length; i += 24) {                               // 24개씩 받기(376개 · 5.5MB)
    await Promise.all(d.cands.slice(i, i + 24).map((x, k) => fetch(`../data/calc/actions/${x.c.id}.json`).then(r => (r.ok ? r.json() : null)).catch(() => null).then(a => { acts[i + k] = a; got++; })));
    tick(`후보 스킬 받기 ${got}/${d.cands.length}`);
  }
  const cands = d.cands.map((x, i) => {
    if (!acts[i]) return null;
    const atks = (x.cc.attacks || []).filter(a => a.mult || a.multMax), attack = AEOpt.attackPool(atks, false)[0] || atks[0];
    return { c: x.c, cc: x.cc, pos: "front", fx: [], atks, attack, weapon: AEParty.bestWeapon(d.db.weapons, x.cc.weapon, attack && attack.dep === "magic"), armor: null, special: [], grasta: [], badges: [], stats: x.cc.stats, zones: x.cc.zones || [], actions: acts[i], lock: [] };
  }).filter(Boolean);
  return AEBuild.recommend(d.team, cands, d.opt, { ...(d.conf || {}), tick });
}
onmessage = async ({ data: d }) => {
  try {
    if (d.mode === "recommend") return postMessage({ done: await recommend(d) });
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
