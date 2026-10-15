// 파티 장비 워커(2026-10-15) — partyGear 는 파티 하나에 수 초라 화면 스레드에서 돌리면 멈춘다. 상위 파티마다 워커 하나(병렬)
//   받는 것: { team, opt, conf, db: {weapons, armor, grasta, badges, ores}, inv: 보유 목록 | null } — team 과 db 를 한 메시지로 보내야
//   장비 객체가 같은 것으로 이어진다(구조화 복제는 한 메시지 안의 참조를 보존). 돌려주는 것: partyGear 결과에서 team 만 뺀 것
importScripts("ae_calc.js", "ae_pipeline.js", "party_calc.js", "optimizer.js");
onmessage = ({ data: d }) => {
  try {
    const cache = new Map();
    const poolsOf = m => cache.get(m.c.id) || cache.set(m.c.id, AEOpt.ownedPools(d.db, m.cc, m.c.traits, d.inv).pools).get(m.c.id);
    const { team, ...r } = AEOpt.partyGear(d.team, d.opt, poolsOf, d.conf);
    postMessage({ done: r });
  } catch (e) {
    postMessage({ error: String((e && e.stack) || e) });
  }
};
