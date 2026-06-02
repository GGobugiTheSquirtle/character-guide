# 어나더에덴 캐릭터 가이드 (character-guide)

어나더에덴 전 캐릭터 카탈로그 + 캐릭터별 깊이 자료 SPA.

- **397명 인덱스**: 카드 그리드 + 검색(한/영/일) + 필터(속성/무기/스타일/성급/SA)
- **264명 풀데이터**: 카드 클릭 시 `data/full/<id>.json` lazy-load — game-info.wiki 운용평가 + namu.wiki 작중행적/평가를 파싱한 클린 텍스트
- **133명 stub**: 한글명만 매핑된 캐릭(confidence 0). namu 검색 링크로 폴백
- 다크 + 골드 톤, 프레임워크 없는 단일 `index.html` + 외부 JSON

## 데이터 구조

```
data/index.json        # 397명 메타(roster) — 카드 렌더용
data/full/<id>.json    # 264명 상세 — game-info 섹션 + namu 섹션
images/icons/          # 397개 캐릭터 아이콘 (id 기준)
```

`index.json.meta`: `total 397 / with_mapping 264 / with_full 264`, version 기준일.

## 로컬 실행

```bash
cd character-guide
py -3.14 -m http.server 8000   # → http://localhost:8000  (fetch() 때문에 file:// 불가)
```

## 출처

- 로스터/매핑: anothereden.wiki (티어리스트 데이터와 동일 소스)
- 운용평가: game-info.wiki
- 작중행적/한국어 평가: namu.wiki

> 이 프로젝트는 `character-list-guide`(10명 PoC) + `character-detail-pages`(1명 PoC)를
> 397명 규모로 통합·대체한 후속 메인이다. 두 PoC는 `_legacy/`로 아카이브됨.
