// 파티 빌드 워커(2026-10-17, plan ae-party-build U1) — AEBuild.optimize 는 실제 4인 수십 초라 화면 스레드에서 돌리면 멈춘다
//   받는 것: { team(계산 멤버 + actions), opt, gear: bool, gearConf, db: {weapons, armor, grasta, badges, ores}, inv: 보유 목록 | null }
//   보내는 것: { tick: 진행 문구 } … { done: 결과(멤버 객체 대신 장비만) } | { error }
importScripts("ae_calc.js", "ae_pipeline.js", "party_calc.js", "optimizer.js", "scenario.js", "planner.js", "build.js");
onmessage = ({ data: d }) => {
  try {
    const conf = { tick: msg => postMessage({ tick: msg }) };
    if (d.gear) {
      const cache = new Map();
      conf.gear = { poolsOf: m => cache.get(m.c.id) || cache.set(m.c.id, AEOpt.ownedPools(d.db, m.cc, m.c.traits, d.inv).pools).get(m.c.id), conf: d.gearConf || {} };
      conf.grantsOf = m => conf.gear.poolsOf(m).grasta.filter(g => g.grant && !g.ore);     // 장비 최적화면 낄 수 있는 그라스타의 부여 스킬 전부
    }
    const r = AEBuild.optimize(d.team, d.opt, conf);
    const { team, ...rest } = r;
    postMessage({ done: { ...rest, gear: team.map(m => ({ weapon: m.weapon || null, armor: m.armor || null, grasta: m.grasta || [], badges: m.badges || [], special: m.special || [] })) } });
  } catch (e) {
    postMessage({ error: String((e && e.stack) || e) });
  }
};
