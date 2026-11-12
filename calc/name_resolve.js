// 이름 해석기 (2026-11-11) — 글에 적힌 캐릭터 · 스킬 이름(한 · 영 · 일 · 별칭)을 멤버 + 스킬칸으로 푼다.
//   입력 색인 = data/calc/skill_names.json(_tools/character/build_skill_names.py, 이름은 전부 ae-db 이름 표)
//   const R = AENames.build(index);  R.resolve("알도 회전 베기, 용신참\n시온 AS …", { party: [ids] })
//     → { members: [{ id, explicit, basis: 'name'|'skills'|'cover', slots: [계산 키], extra, alt }], warnings: [{ kind, … }], unknown: [글자], seq: [{ id, name }] }
//        seq = 적힌 순서대로의 행동(같은 스킬을 다시 적으면 다시 — 파티 빌드 「순서 입력」, 11-12)
//   문장을 만들지 않는다(경고는 자료 — 화면이 글로 옮긴다). 계산 키 = 행동 단위 스킬 name.
//   ctx: party = 지금 파티 id(같은 이름이면 파티 안 캐릭터가 먼저) · fuzzy = 'char'(기본 — 적힌 캐릭터의 스킬 안에서만 한 글자 오타 보정) | 'off' | 'global'(전체에서 — 글 속 낱말 표본 40 중 28이 틀려 기본으로 안 씀)
//        loneMin = 이름 없이 스킬 하나로 캐릭터를 세우는 최소 글자 수(기본 3) · cover = false 면 「여럿이 가진 이름을 혼자 덮는 캐릭터」 추정을 끈다(측정용)
//   수치 근거 = node _tools/character/measure_names.cjs (기록 .gongbang/plans/ae-party-build.plan.md)
//
//   읽는 법  1) 정규화: NFKC · 소문자 · 글자/숫자만(이름 끝에 붙은 '+' 는 남긴다 — 「X」와 「X+」는 다른 스킬)
//            2) 끊기: 사전(캐릭터 키 ∪ 스킬 키)으로 덮는 글자 수가 최대가 되게 나눈다(동적 계획). 이름은 낱말 경계 · 앞 이름 바로 뒤에서만 시작하고,
//               경계 · 조사 · 다음 이름 앞에서만 끝난다(「기도하다」 속 「기도」는 안 잡는다). 쉼표 · 빗금을 가로지르는 이름은 벌점, 줄바꿈은 못 넘는다.
//            3) 묶기: 캐릭터 이름 = 묶음. 스킬은 그 스킬을 가진 묶음에 — 바로 앞 캐릭터 → 같은 줄 묶음 → 가장 가까운 묶음(줄이 다르면 멀다, 스킬칸 4개가 찬 묶음은 건너뜀).
//               가진 묶음이 없으면 스킬만으로 캐릭터를 세운다: 한 캐릭터만 가진 이름 → 그 캐릭터(basis 'skills') ·
//               여럿이 가진 이름만 있는 줄 → 그 줄을 혼자 가장 많이(2개 이상) 덮는 캐릭터(basis 'cover'), 못 가리면 묻는다(ambiguous_skill).
//               캐릭터 이름이면서 스킬 이름인 낱말(Benedict · Blooming Blade)은 파티 쪽 뜻으로, 파티를 모르면 글에 캐릭터 이름이 없고 다른 스킬이 있을 때만 스킬.
//            4) 고르기: 묶음마다 후보(스타일 · 이경 · 동명) 중 적힌 스킬을 가장 많이 가진 쪽(확실한 스킬이 어림보다 먼저). 같은 캐릭터의 두 스타일은 한 묶음으로 합친다.
//   경고 kind: ambiguous_char(이름이 여럿) · ambiguous_skill(주인을 못 가림) · shared_skill(어림으로 넣음 — alt 도 가진다) · not_owned · no_slot · over4 · dup_family · fuzzy(오타 보정) · lone_skill
(function (root) {
  "use strict";
  const KEEP = /[\p{L}\p{N}]/u;
  const norm = s => String(s == null ? "" : s).normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}+]+/gu, "");
  const family = id => id.replace(/(_alter)?(_as|_es)?$/, "");
  const styleOf = id => (/_as$/.test(id) ? "as" : /_es$/.test(id) ? "es" : "ns");
  // 이용자가 스타일을 적는 말(게임 용어 정본이 아니라 입력 어휘)
  const TAG = {
    as: ["as", "어나더", "어나더스타일", "another", "anotherstyle", "アナザー", "アナザースタイル"],
    es: ["es", "엑스트라", "엑스트라스타일", "extra", "extrastyle", "エクストラ", "エクストラスタイル"],
    ns: ["ns", "노멀", "노말", "normal", "normalstyle", "ノーマル"],
    alter: ["alter", "얼터", "이경", "異境", "異時層", "アルター"],
  };
  for (const k in TAG) TAG[k] = TAG[k].map(norm);
  const PARTICLES = ["으로", "이랑", "에게", "한테", "까지", "부터", "이나", "하고", "에서", "은", "는", "이", "가", "을", "를", "의", "와", "과", "랑", "도", "에", "로", "만", "나",
    "の", "は", "が", "を", "と", "に", "も", "で"];
  const BRK = { none: 0, soft: 1, list: 2, hard: 3 };
  const LONE_MIN = 3;                                      // 이름 없이 스킬 하나만으로 캐릭터를 세우는 최소 글자 수 — 2글자 스킬 이름은 글 속에서 보통 낱말(링크 · 차지 · 기도, 표본 16 중 11)
  const LIST = /[,，、\/|;；]/, HARD = /[\n\r]/;

  function build(index) {
    const chars = index.chars || index, ids = Object.keys(chars);
    const fam = {}, alterFam = new Set();
    for (const id of ids) { (fam[family(id)] = fam[family(id)] || []).push(id); if (/_alter/.test(id)) alterFam.add(family(id)); }
    const charKeys = new Map(), skillKeys = new Map();      // key → Map(id → rank) · key → Map(id → { name, slot })
    const addC = (k, id, rank) => { if (!k) return; let m = charKeys.get(k); if (!m) charKeys.set(k, m = new Map()); if (!m.has(id) || m.get(id) > rank) m.set(id, rank); };
    const tagged = (id, k) => { const st = styleOf(id); return st !== "ns" && TAG[st].some(t => k.length > t.length && k.endsWith(t)); };
    const bare = {};                                        // family → Map(bare key → rank)
    for (const id of ids) {
      const c = chars[id], f = family(id);
      (c.n || []).forEach((name, i) => {
        const k = norm(name), rank = i ? 0.2 : 0;
        if (tagged(id, k)) return addC(k, id, rank);        // 「알도 AS」 = 그 스타일만
        for (const x of fam[f]) addC(k, x, x === id ? rank : rank + 0.1);     // 맨 이름 = 그 캐릭터의 모든 스타일
        const b = bare[f] = bare[f] || new Map();
        if (!b.has(k) || b.get(k) > rank) b.set(k, rank);
      });
      for (const name of c.p || []) addC(norm(name), id, 1);                  // 인물 이름(이경이 함께 쓰는 이름)
      for (const row of c.s || []) {
        const e = { name: row[0], slot: !!row[1] };
        for (const a of [row[0], ...row.slice(2)]) {
          const k = norm(a);
          if (!k) continue;
          let m = skillKeys.get(k); if (!m) skillKeys.set(k, m = new Map());
          if (!m.has(id)) m.set(id, e);
        }
      }
    }
    // 스타일을 붙여 적은 꼴(「알도 AS」 · 「AS 알도」 · 「시온 얼터」) — 색인에 없는 조합만 만든다
    const synth = [];
    for (const f in fam) {
      const mem = fam[f], isAlter = alterFam.has(f);
      const of = st => mem.filter(id => styleOf(id) === st);
      const names = [...(bare[f] || new Map()).keys()];
      const persons = isAlter ? [...new Set(mem.flatMap(id => (chars[id].p || []).map(norm)))].filter(Boolean) : [];
      for (const st of ["as", "es", "ns"]) {
        const tgt = of(st);
        if (!tgt.length || (st === "ns" && mem.length < 2)) continue;
        for (const k of names) for (const t of TAG[st]) for (const id of tgt) synth.push([k + t, id], [t + k, id]);
        for (const k of persons) for (const a of TAG.alter) for (const id of tgt) {
          if (st === "ns") synth.push([k + a, id], [a + k, id]);
          else for (const t of TAG[st]) synth.push([k + a + t, id], [a + k + t, id], [k + t + a, id]);
        }
      }
    }
    for (const [k, id] of synth) if (!skillKeys.has(k)) addC(k, id, 0.3);
    const first = new Map();                                // 첫 글자 → 그 글자로 시작하는 키의 최대 길이
    const dict = new Set([...charKeys.keys(), ...skillKeys.keys()]);
    for (const k of dict) if ((first.get(k[0]) || 0) < k.length) first.set(k[0], k.length);

    // ── 끊기 ────────────────────────────────────────────────────────────
    function scan(text) {
      const src = String(text == null ? "" : text).normalize("NFKC");
      const ch = [], at = [], end = [], brk = [];
      let pend = BRK.hard, prevKept = false;
      for (let i = 0; i < src.length;) {
        const cp = src.codePointAt(i), raw = String.fromCodePoint(cp), n = raw.length;
        const plus = raw === "+" && prevKept;                // 이름에 붙은 '+' 만 글자로
        if (KEEP.test(raw) || plus) {
          const low = raw.toLowerCase();
          for (let u = 0; u < low.length; u++) { ch.push(low[u]); at.push(i); end.push(i + n); brk.push(u ? BRK.none : pend); }
          pend = BRK.none; prevKept = !plus;
        } else {
          pend = Math.max(pend, HARD.test(raw) ? BRK.hard : LIST.test(raw) ? BRK.list : BRK.soft);
          prevKept = false;
        }
        i += n;
      }
      return { src, s: ch.join(""), at, end, brk };
    }
    function tokenize(text) {
      const { src, s, at, end, brk } = scan(text), N = s.length;
      const bound = j => j >= N || brk[j] >= BRK.soft;
      const nextB = new Int32Array(N + 1), nextHard = new Int32Array(N + 1), cross = new Int32Array(N + 2);
      nextB[N] = nextHard[N] = N;
      for (let i = N - 1; i >= 0; i--) {
        nextB[i] = i + 1 < N && brk[i + 1] < BRK.soft ? nextB[i + 1] : i + 1;
        nextHard[i] = i + 1 < N && brk[i + 1] < BRK.hard ? nextHard[i + 1] : i + 1;
      }
      for (let i = 0; i < N; i++) cross[i + 1] = cross[i] + (brk[i] === BRK.list ? 1 : 0);
      const partEnd = j => { for (const p of PARTICLES) if (s.startsWith(p, j) && bound(j + p.length)) return j + p.length; return -1; };
      const NEG = -1e15, F = new Float64Array(N + 1), G = new Float64Array(N + 1), fc = new Int32Array(N + 1), gc = new Int32Array(N + 1);
      // 선택 부호: 0 = 낱말 건너뜀, -1 = '+' 건너뜀, -2 = 조사, L > 0 = 길이 L 키
      for (let i = N - 1; i >= 0; i--) {
        const maxL = Math.min(first.get(s[i]) || 0, nextHard[i] - i);
        let bf = F[nextB[i]], cf = 0, bg = NEG, cg = 0;
        if (s[i] === "+") { bf = F[i + 1]; cf = -1; bg = F[i + 1]; cg = -1; }
        const pe = partEnd(i);
        if (pe > 0 && F[pe] > bg) { bg = F[pe]; cg = -2; }
        for (let L = 1; L <= maxL; L++) {
          if (!dict.has(s.substr(i, L))) continue;
          const j = i + L, tail = bound(j) ? F[j] : G[j];
          if (tail <= NEG / 2) continue;
          const v = L * 1000 - 10 - (cross[j] - cross[i + 1]) * 100 + tail;
          if (L === 1) { if ((bound(j) || partEnd(j) > 0) && v > bf) { bf = v; cf = L; } if (v > bg) { bg = v; cg = L; } continue; }   // 한 글자 이름은 홀로 선 낱말이거나 앞 이름에 바로 붙었을 때만(「마인드스탬프힐번개차지」)
          if (v > bf) { bf = v; cf = L; }
          if (v > bg) { bg = v; cg = L; }
        }
        F[i] = bf; fc[i] = cf; G[i] = bg; gc[i] = cg;
      }
      const out = [];
      let i = 0, free = true;
      while (i < N) {
        const c = free ? fc[i] : gc[i];
        if (c > 0) { out.push({ key: s.substr(i, c), text: src.slice(at[i], end[i + c - 1]), a: at[i], brk: brk[i] }); i += c; free = bound(i); }
        else if (c === -1) { i += 1; free = true; }
        else if (c === -2) { i = partEnd(i); free = true; }
        else { const j = nextB[i]; out.push({ unknown: true, key: s.slice(i, j), text: src.slice(at[i], end[j - 1]), a: at[i], brk: brk[i] }); i = j; free = true; }
      }
      return out;
    }

    // ── 오타 한 글자(연구용 선택 기능) — 키에서 한 글자 뺀 꼴 색인(SymSpell 식) ──────────
    let delIdx = null;
    const dels = k => { const o = new Set([k]); for (let i = 0; i < k.length; i++) o.add(k.slice(0, i) + k.slice(i + 1)); return o; };
    function near(q) {
      if (!delIdx) { delIdx = new Map(); for (const k of dict) if (k.length >= 3) for (const d of dels(k)) { let a = delIdx.get(d); if (!a) delIdx.set(d, a = []); a.push(k); } }
      const hit = new Set();
      for (const d of dels(q)) for (const k of delIdx.get(d) || []) {
        if (k === q || Math.abs(k.length - q.length) > 1) continue;
        let a = 0, b = 0, e = 0;                             // 편집 거리 ≤ 1 확인(뺀 꼴이 같아도 거리 2 일 수 있다)
        while (a < k.length && b < q.length && e < 2) {
          if (k[a] === q[b]) { a++; b++; continue; }
          e++;
          if (k.length > q.length) a++; else if (k.length < q.length) b++; else { a++; b++; }
        }
        if (e + (k.length - a) + (q.length - b) <= 1) hit.add(k);
      }
      return [...hit];
    }

    // ── 묶기 · 고르기 ────────────────────────────────────────────────────
    function resolve(text, ctx) {
      ctx = ctx || {};
      const party = new Set(ctx.party || []), fuzzy = ctx.fuzzy || "char";
      let toks = tokenize(text);
      const warnings = [], unknown = [];
      const groups = [], byKey = new Map(), orphans = [];
      const newGroup = (key, cands, pos, basis, label) => { const g = { key, cands, pos, basis, label, explicit: basis === "name", skills: [], at: [] }; groups.push(g); return g; };
      const owns = (g, S) => { for (const id of S.keys()) if (g.key[0] === "~" ? family(id) === g.key.slice(1) : g.cands.has(id)) return true; return false; };
      if (fuzzy !== "off") {                                 // 못 읽은 낱말 연달아 → 한 덩어리로 가까운 이름 찾기
        const merged = [];
        for (const t of toks) {
          const p = merged[merged.length - 1];
          if (t.unknown && p && p.unknown && t.brk < BRK.list) { p.key += t.key; p.text += " " + t.text; p.parts.push(t); }
          else merged.push(t.unknown ? { ...t, parts: [t] } : t);
        }
        toks = merged;
      }
      // 캐릭터 이름이면서 스킬 이름인 낱말(Benedict · Blooming Blade) — 글에 캐릭터 이름이 하나도 없고 다른 스킬이 있으면 스킬로 읽는다. 파티를 알면 파티 쪽 뜻으로.
      const pureChar = toks.some(t => !t.unknown && charKeys.has(t.key) && !skillKeys.has(t.key)), pureSkill = toks.some(t => !t.unknown && skillKeys.has(t.key) && !charKeys.has(t.key));
      const inParty = M => { for (const id of M.keys()) if (party.has(id)) return true; return false; };
      const asSkill = (C, S) => (inParty(C) !== inParty(S) ? inParty(S) : !pureChar && pureSkill);
      let cur = null, line = 0;
      toks.forEach((t, pos) => {
        if (pos && t.brk === BRK.hard) line++;
        t.pos = pos; t.line = line;
        if (t.unknown) {
          if (fuzzy !== "off" && t.key.length >= 3 && !/^\d+$/.test(t.key)) {
            const ks = near(t.key);
            const mine = cur ? ks.filter(k => skillKeys.has(k) && owns(cur, skillKeys.get(k))) : [];
            const pick = mine.length === 1 ? mine[0] : fuzzy === "global" && ks.length === 1 && t.key.length >= 4 ? ks[0] : null;
            if (pick) { warnings.push({ kind: "fuzzy", from: t.text, to: pick }); t = { ...t, unknown: false, key: pick, fuzzy: true }; }
          }
          if (t.unknown) { for (const p of t.parts || [t]) if (!/^\d+$/.test(p.key)) unknown.push(p.text); return; }
        }
        const C = charKeys.get(t.key), S = skillKeys.get(t.key);
        if (C && !(S && ((cur && owns(cur, S)) || asSkill(C, S)))) {
          cur = byKey.get(t.key) || byKey.set(t.key, newGroup(t.key, C, pos, "name", t.text)).get(t.key);
          cur.at.push(t);
          return;
        }
        if (cur && owns(cur, S)) cur.skills.push(t); else orphans.push(t);
      });
      // 스킬칸 4개가 찬 묶음은 주인 없는 스킬을 더 받지 않는다 — 다섯째부터는 다른 캐릭터 것일 가능성이 크다(같은 이름을 여러 캐릭터가 쓸 때)
      const full = g => { for (const id of g.cands.keys()) { const s = new Set(); for (const t of g.skills) { const e = skillKeys.get(t.key).get(id); if (e && e.slot) s.add(e.name); } if (s.size >= 4) return true; } return false; };
      // 가까움 = 그 묶음의 이름 · 스킬 중 가장 가까운 낱말까지(줄이 다르면 멀다 — 한 줄 = 한 캐릭터로 적는 글이 많다). 같으면 앞 묶음(스킬은 캐릭터 뒤에 적는다).
      // 어림 = 줄 거리가 같은 묶음이 둘 이상 · 다른 줄 묶음에 넣었는데 아직 안 나온 주인이 있음 · 덮기 추정 → t.rivals · t.rivalIds 에 남겨 화면이 알린다(shared_skill)
      const LINE = 1000;
      const ownersOf = t => { const all = [...skillKeys.get(t.key).keys()], inP = all.filter(id => party.has(id)); return inP.length ? inP : all; };
      const implicit = new Map();
      const imp = (f, pos, basis) => implicit.get(f) || implicit.set(f, newGroup("~" + f, new Map(), pos, basis, null)).get(f);
      const put = (g, t, o) => { for (const id of o) if (family(id) === g.key.slice(1)) g.cands.set(id, 2); g.skills.push(t); };
      const place = (g, t) => { if (g.key[0] === "~") put(g, t, ownersOf(t)); else g.skills.push(t); };
      const hasGroup = f => implicit.has(f) || groups.some(g => g.explicit && [...g.cands.keys()].some(id => family(id) === f));
      const dist = (g, t) => { let d = Infinity, before = 1; for (const x of g.at.concat(g.skills)) { const v = Math.abs(x.line - t.line) * LINE + Math.abs(x.pos - t.pos); if (v < d || (v === d && x.pos < t.pos)) { d = v; before = x.pos < t.pos ? 0 : 1; } } return [d, before]; };
      const nearest = (t, gs, maxCls) => {
        const c = gs.filter(g => owns(g, skillKeys.get(t.key)) && !full(g)).map(g => ({ g, d: dist(g, t) })).sort((a, b) => a.d[0] - b.d[0] || a.d[1] - b.d[1] || a.g.pos - b.g.pos);
        const cls = c.length ? Math.floor(c[0].d[0] / LINE) : 0;
        if (!c.length || (maxCls != null && cls > maxCls)) return null;
        const riv = c.slice(1).filter(x => Math.floor(x.d[0] / LINE) === cls).map(x => x.g);
        if (riv.length) t.rivals = riv;
        if (party.size || cls >= 1) { const fr = ownersOf(t).filter(id => !hasGroup(family(id))); if (fr.length) t.rivalIds = fr; }   // 다른 줄 묶음에 넣었는데 아직 안 나온 주인이 있다
        return c[0].g;
      };
      let rest = [];
      for (const t of orphans) { const g = nearest(t, groups); if (g) g.skills.push(t); else rest.push(t); }
      // 가진 묶음이 없는 스킬 — 스킬만으로 캐릭터 추정
      let multi = [];
      for (const t of rest) {
        const o = ownersOf(t), fs = new Set(o.map(family));
        if (fs.size === 1) put(imp([...fs][0], t.pos, "skills"), t, o); else multi.push(t);
      }
      rest = [];
      for (const t of multi) { const g = nearest(t, groups, 0); if (g) place(g, t); else rest.push(t); }      // 같은 줄에 가진 묶음이 있으면 거기
      // 묶음이 없는 줄에 낱말이 둘 이상 = 그 줄은 아직 안 나온 캐릭터(한 줄 = 한 캐릭터) — 혼자 가장 많이 덮는 캐릭터로, 못 가리면 묻는다(다른 줄 묶음에 넣지 않는다)
      const lines = new Map();
      for (const t of rest) lines.set(t.line, (lines.get(t.line) || []).concat([t]));
      for (const ts of lines.values()) {
        if (ts.length < 2 || ctx.cover === false) continue;
        const cnt = new Map();
        for (const t of ts) for (const f of new Set(ownersOf(t).map(family))) if (!hasGroup(f)) cnt.set(f, (cnt.get(f) || 0) + 1);
        const top = [...cnt].sort((a, b) => b[1] - a[1]);
        if (!top.length) continue;
        if (top[0][1] >= 2 && !(top[1] && top[1][1] === top[0][1])) { for (const t of ts) { const o = ownersOf(t); if (o.some(id => family(id) === top[0][0])) { put(imp(top[0][0], t.pos, "cover"), t, o); t.rivalIds = o; t.done = true; } } }
        else for (const t of ts) t.hold = true;
      }
      multi = rest.filter(t => !t.done); rest = [];
      for (const t of multi) { const g = t.hold ? null : nearest(t, groups); if (g) place(g, t); else rest.push(t); }
      while (rest.length) {                                  // 여러 캐릭터가 가진 이름만 남음 — 둘 이상을 혼자 덮는 캐릭터가 하나뿐이면 그 캐릭터
        const cnt = new Map();
        for (const t of rest) for (const f of new Set(ownersOf(t).map(family))) if (!(implicit.has(f) && full(implicit.get(f)))) cnt.set(f, (cnt.get(f) || 0) + 1);
        const top = [...cnt].sort((a, b) => b[1] - a[1]);
        if (ctx.cover === false || !top.length || top[0][1] < 2 || (top[1] && top[1][1] === top[0][1])) break;
        const f = top[0][0], keep = [];
        for (const t of rest) { const o = ownersOf(t); if (o.some(id => family(id) === f)) { put(imp(f, t.pos, "cover"), t, o); t.rivalIds = o; } else keep.push(t); }
        rest = keep;
      }
      for (const t of rest) warnings.push({ kind: "ambiguous_skill", skill: t.text, owners: ownersOf(t) });
      // 짧은 스킬 이름 하나만으로 세운 캐릭터는 멤버로 올리지 않는다(「조사」 · 「기도」 같은 보통 낱말) — loneMin 글자 미만
      const loneMin = ctx.loneMin == null ? LONE_MIN : ctx.loneMin;
      for (let i = groups.length - 1; i >= 0; i--) {
        const g = groups[i];
        if (g.basis !== "skills" || g.skills.length !== 1 || [...g.skills[0].key].length >= loneMin || [...g.cands.keys()].some(id => party.has(id))) continue;
        warnings.push({ kind: "lone_skill", skill: g.skills[0].text, owners: [...g.cands.keys()] });
        groups.splice(i, 1);
      }

      // 묶음마다 캐릭터 하나 — 후보 가족이 적은 묶음부터
      const famCount = g => new Set([...g.cands.keys()].map(family)).size;
      const order = groups.slice().sort((a, b) => famCount(a) - famCount(b) || a.pos - b.pos);
      const taken = new Map(), ST = { ns: 0, as: 1, es: 2 };
      const ownedN = (g, id) => g.skills.reduce((n, t) => n + (skillKeys.get(t.key).has(id) ? 1 : 0), 0);
      const sureN = (g, id) => g.skills.reduce((n, t) => n + (!t.rivals && !t.rivalIds && skillKeys.get(t.key).has(id) ? 1 : 0), 0);   // 어림으로 넣은 스킬보다 확실한 스킬이 먼저
      const oneFam = t => new Set([...skillKeys.get(t.key).keys()].map(family)).size === 1;
      const soleN = (g, id) => g.skills.reduce((n, t) => n + (oneFam(t) && skillKeys.get(t.key).has(id) ? 1 : 0), 0);   // 이 캐릭터만 가진 스킬이 가장 먼저(「래빗 스텝, 어스 월」 → 래빗 스텝을 가진 스타일)
      for (const g of order) {
        // 이경(Alter)은 제 이름 · 「얼터」 꼬리표 · 가진 스킬로만 고른다 — 원래 캐릭터와 함께 쓰는 이름이면 원래 캐릭터가 먼저
        const sc = [...g.cands].map(([id, rank]) => ({ id, rank, free: taken.has(family(id)) ? 0 : 1, sole: soleN(g, id), sure: sureN(g, id), own: ownedN(g, id), inP: party.has(id) ? 1 : 0, alt: alterFam.has(family(id)) ? 1 : 0 }))
          .sort((a, b) => b.free - a.free || b.sole - a.sole || b.sure - a.sure || b.own - a.own || b.inP - a.inP || a.alt - b.alt || a.rank - b.rank || ST[styleOf(a.id)] - ST[styleOf(b.id)] || (a.id < b.id ? -1 : 1));
        const best = sc[0];
        if (!best.free) {                                    // 같은 캐릭터의 다른 스타일이 이미 자리잡음 — 한 파티에 둘은 못 선다
          const into = taken.get(family(best.id));
          into.skills.push(...g.skills); into.pos = Math.min(into.pos, g.pos); g.merged = true; g.into = into;
          if (g.explicit) warnings.push({ kind: "dup_family", name: g.label, id: into.id });
          const again = [...into.cands.keys()].filter(id => family(id) === family(into.id)).map(id => ({ id, own: ownedN(into, id) })).sort((a, b) => b.own - a.own)[0];
          if (again && again.own > ownedN(into, into.id)) into.id = again.id;
          continue;
        }
        g.id = best.id; taken.set(family(best.id), g);
        g.alt = sc.filter(x => x.id !== best.id && x.free && x.own === best.own).map(x => x.id);
        const rival = sc.find(x => x.free && family(x.id) !== family(best.id) && x.own === best.own && x.rank === best.rank && x.inP === best.inP && x.alt === best.alt);
        if (rival) warnings.push({ kind: "ambiguous_char", name: g.label || g.skills.map(t => t.text).join(", "), id: best.id, alt: sc.filter(x => x.free && family(x.id) !== family(best.id) && x.own === best.own && x.rank === best.rank && x.inP === best.inP && x.alt === best.alt).map(x => x.id) });
      }
      const acts = [];                                       // 행동 순서(11-12 순서 입력) — 글에 적힌 순서 그대로(같은 스킬을 다시 적으면 다시), 멤버가 가진 스킬만
      const members = groups.filter(g => !g.merged).sort((a, b) => a.pos - b.pos).map(g => {
        const slots = [], extra = [], seen = new Set();
        for (const t of g.skills.slice().sort((a, b) => a.pos - b.pos)) {
          const m = skillKeys.get(t.key), e = m.get(g.id);
          if (!e) { warnings.push(t.rivals || t.rivalIds || (!g.explicit && !oneFam(t)) ? { kind: "ambiguous_skill", skill: t.text, owners: ownersOf(t) } : { kind: "not_owned", skill: t.text, id: g.id, owners: [...m.keys()] }); continue; }   // 어림 · 스킬만으로 세운 묶음인데 고른 스타일이 안 가짐 → 묻는다
          acts.push({ pos: t.pos, id: g.id, name: e.name });
          if (seen.has(e.name)) continue;
          seen.add(e.name);
          const alt = [...new Set((t.rivals || []).map(r => (r.into || r).id).concat(t.rivalIds || []))].filter(id => id && id !== g.id && family(id) !== family(g.id) && m.has(id));
          if (alt.length) warnings.push({ kind: "shared_skill", skill: t.text, id: g.id, alt });
          if (!e.slot) { warnings.push({ kind: "no_slot", skill: e.name, id: g.id }); extra.push(e.name); }
          else if (slots.length >= 4) { warnings.push({ kind: "over4", skill: e.name, id: g.id }); extra.push(e.name); }
          else slots.push(e.name);
        }
        return { id: g.id, explicit: g.explicit, basis: g.basis, label: g.label, slots, extra, alt: g.alt || [] };
      });
      return { members, warnings, unknown, seq: acts.sort((a, b) => a.pos - b.pos).map(({ id, name }) => ({ id, name })) };
    }
    return { resolve, tokenize, near, charKeys, skillKeys, chars, norm, family };
  }

  const api = { build, norm, family };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.AENames = api;
})(typeof self !== "undefined" ? self : globalThis);
