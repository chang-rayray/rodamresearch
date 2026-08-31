// 키워드 시장조사 자동 실행 API
// 대시보드에서 키워드를 받아: 네이버 오픈API(블로그/카페/지식iN/지역검색) + 네이버 검색광고(절대 검색량)를
// 호출해 원시 데이터를 모은 뒤, Claude API로 로담한의원 keyword-market-research 스킬과 동일한 구조의
// 리포트 본문을 합성하고, 프로젝트 표준 디자인 셸(paper/jade/clay 팔레트)에 끼워 넣어 반환한다.
//
// 필요한 Vercel 환경변수:
//   NAVER_CLIENT_ID, NAVER_CLIENT_SECRET       — 네이버 오픈API(검색)
//   NAVER_AD_API_KEY, NAVER_AD_SECRET_KEY, NAVER_AD_CUSTOMER_ID — 네이버 검색광고 API
//   ANTHROPIC_API_KEY                          — Claude API

import { createHmac } from "node:crypto";
import { put } from "@vercel/blob";

export const config = { runtime: "nodejs" };

function sanitizeForFilename(s) {
  return s.replace(/[\\/:*?"<>|]/g, "_").trim();
}

const BRAND_CONTEXT = `
# 로담한의원 브랜드 팩트 (요약)
- 회사명: 로담한의원. 2006년 강남점 개원, 18년 이상 임상 역사. "새살침 코라테라피"(2007년 특허 상표)를 최초 개발한 흉터 특화 한의원.
- 규모: 전국 9개 지점(강남본점, 잠실, 홍대신촌, 노원, 가산금천, 수원, 천안, 부산, 대구) + 캐나다 밴쿠버(신규 레이저 서비스 한정, 정식 지점 여부 미확인).
- 주력 카테고리: 여드름흉터, 성형수술흉터, 수두흉터, 대상포진흉터 등 패인흉터 전반.
- 실수치(그대로 인용, 가공 금지): 2023년 12월 기준 누적 시술 사례 8만 건 이상. 의료소비자 만족도 평가 2016~2024년 총 7회 1등급, 2024년 98.5점(역대 최고점). 연평균 1,000명 이상 외국인 환자. 평균 8~10회 치료(4~5개월), 2~3주 간격, 코 등 고난도 부위 약 90% 복원 목표.
- 신규 서비스(2026년 확장): 편평사마귀·쥐젖(연성섬유종)·지루각화증 레이저 치료 (Er:YAG+CO2 듀얼 레이저, "4CLEAR 시스템"). 전 지점 + 밴쿠버 제공.
- 타겟 고객: 20~30대 남녀(남성 비중 약 50%), 사춘기/성인 여드름과 패인 흉터·색소침착 고민.
- 사용 규칙: 숫자 반올림/가공 금지, 확인 안 된 성과는 쓰지 않는다(픽션 금지). 이 브랜드 팩트 외의 자사 실적을 지어내지 말 것.
`.trim();

const COMPETITOR_CONTEXT = `
# 기존에 확인된 주요 경쟁사(반복 등장, 참고용 — 검색 결과에 이 이름이 보이면 "기존 확인 경쟁사"로 언급)
- 후한의원(강남·대전·수원·광주·전주 등): 자체 시술명 "트랜스테라피", 수두흉터/새살침/지루각화증 카테고리에서 로담과 가장 광범위하게 겹침.
- 해율한의원(강남·수원·광주·울산·목동): 자체 시술명 "오름침/오름테라피", 여드름흉터/수두흉터/쥐젖/지루각화증.
- 생기한의원(노원·강남역·수원): 편평사마귀/모공각화증/지루성피부염, 전용 카페(cafe.naver.com/dnfdot).
- 화접몽한의원(네트워크): 모공각화증/편평사마귀, 전용 카페(cafe.naver.com/samcclan).
- 온바디한의원: 여드름흉터+한방가슴성형+한약다이어트 겸업, 자체 카페(cafe.naver.com/alstj5646)에서 흉터 키워드 스터핑 콘텐츠 생산.
- 연세스타피부과, 유클리닉, 진성형외과, 닥터라이언(블로그 2개+Threads 운영) 등 피부과·성형외과 진영도 흉터 카테고리 전반에서 강경쟁.
검색 결과에 위 목록에 없는 새로운 경쟁사명이 반복 등장하면 "신규 경쟁사 후보"로 표시할 것.
`.trim();

function stripHtml(s) {
  return (s || "").replace(/<\/?b>/g, "").replace(/&quot;/g, '"').replace(/&amp;/g, "&").trim();
}

async function naverSearch(kind, query, display, sort) {
  const clientId = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;
  if (!clientId || !clientSecret) return { items: [], error: "missing_credentials" };

  const params = new URLSearchParams({ query, display: String(display), sort });
  const url = `https://openapi.naver.com/v1/search/${kind}.json?${params.toString()}`;
  try {
    const res = await fetch(url, {
      headers: {
        "X-Naver-Client-Id": clientId,
        "X-Naver-Client-Secret": clientSecret,
      },
    });
    if (!res.ok) return { items: [], error: `http_${res.status}` };
    const data = await res.json();
    const items = (data.items || []).map((it) => ({
      title: stripHtml(it.title),
      description: stripHtml(it.description).slice(0, 160),
      link: it.link,
      source: it.bloggername || it.cafename || undefined,
    }));
    return { items };
  } catch (e) {
    return { items: [], error: String(e) };
  }
}

async function googleSearch(query, num) {
  const key = process.env.GOOGLE_CSE_KEY;
  const cx = process.env.GOOGLE_CSE_CX;
  if (!key || !cx) return { items: [], error: "missing_credentials" };

  const params = new URLSearchParams({
    key,
    cx,
    q: query,
    num: String(Math.min(num, 10)),
    hl: "ko",
    gl: "kr",
  });
  try {
    const res = await fetch(`https://www.googleapis.com/customsearch/v1?${params.toString()}`);
    if (!res.ok) {
      const t = await res.text();
      return { items: [], error: `http_${res.status}: ${t.slice(0, 200)}` };
    }
    const data = await res.json();
    const items = (data.items || []).map((it) => ({
      title: it.title,
      description: (it.snippet || "").slice(0, 200),
      link: it.link,
      source: it.displayLink,
    }));
    return { items };
  } catch (e) {
    return { items: [], error: String(e) };
  }
}

function signSearchAd(timestamp, method, uri, secretKey) {
  const message = `${timestamp}.${method}.${uri}`;
  return createHmac("sha256", secretKey).update(message).digest("base64");
}

async function naverSearchAdVolume(keywords) {
  const API_KEY = process.env.NAVER_AD_API_KEY;
  const SECRET_KEY = process.env.NAVER_AD_SECRET_KEY;
  const CUSTOMER_ID = process.env.NAVER_AD_CUSTOMER_ID;
  if (!API_KEY || !SECRET_KEY || !CUSTOMER_ID) return { rows: [], error: "missing_credentials" };

  const method = "GET";
  const uri = "/keywordstool";
  const timestamp = Date.now().toString();
  const signature = signSearchAd(timestamp, method, uri, SECRET_KEY);
  const params = new URLSearchParams({
    hintKeywords: keywords.map((k) => k.replace(/\s+/g, "")).join(","),
    showDetail: "1",
  });

  try {
    const res = await fetch(`https://api.naver.com${uri}?${params.toString()}`, {
      method,
      headers: {
        "X-Timestamp": timestamp,
        "X-API-KEY": API_KEY,
        "X-Customer": CUSTOMER_ID,
        "X-Signature": signature,
      },
    });
    const text = await res.text();
    if (!res.ok) return { rows: [], error: `http_${res.status}: ${text.slice(0, 200)}` };
    const data = JSON.parse(text);
    const rows = (data.keywordList || []).slice(0, 40).map((k) => ({
      키워드: k.relKeyword,
      PC월간검색수: k.monthlyPcQcCnt,
      모바일월간검색수: k.monthlyMobileQcCnt,
      경쟁정도: k.compIdx,
    }));
    return { rows };
  } catch (e) {
    return { rows: [], error: String(e) };
  }
}

async function callClaude(keyword, raw) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY 환경변수가 설정되어 있지 않습니다.");

  const system = `당신은 로담한의원(흉터 전문 한의원)의 키워드 시장조사 애널리스트입니다.
${BRAND_CONTEXT}

${COMPETITOR_CONTEXT}

## 작업
주어진 키워드에 대한 네이버 검색 원시 데이터(블로그/카페/지식iN/지역검색/검색광고 절대검색량/웹문서검색)를
분석해서 로담한의원 브랜드의 노출 현황과 경쟁 구도, 개선 제안을 도출하세요.

## 원칙
- 응답 시간 제약이 있으니 간결하게 작성한다. 섹션당 본문은 2~4개 문단/요소 이내로, 전체 5개 섹션을 넘기지 않는다.
- 숫자는 원시 데이터에 있는 그대로만 인용하고 반올림하거나 지어내지 않는다.
- "확정 노출"(로담 또는 지점명이 본문/제목에 명시된 글)과 "추정 노출"(브랜드명 없이 정황상 로담 관련 가능성이 있는 글, 확인 필요로 표시)을 구분한다.
- 원시 데이터에 없는 사실은 만들어내지 않는다. 근거가 부족하면 "확인 필요"라고 명시한다.
- 반드시 한국어로 작성한다.
- 실제 구글 검색은 이 자동화 파이프라인에서 호출할 수 없다. naver_webkr_as_web_context는 네이버
  오픈API의 "웹문서검색"(네이버 자체 웹 인덱스) 결과로, 구글 검색 결과를 대체하는 근사치다. 이 데이터로
  섹션을 작성할 때는 반드시 "네이버 웹문서검색 기준"이라고 명시하고, 구글 조사라고 단정하지 말 것.

## 출력 형식
JSON이 아니라 아래 구분자 포맷으로만 출력하세요. 다른 설명·인사말·코드펜스 없이 이 포맷만 그대로 따르세요.
구분자 줄(<<<로 시작하는 줄)은 정확히 이 형태를 지키고, 그 사이 본문에는 순수 HTML을 이스케이프 없이 그대로 작성합니다
(HTML 속성에 큰따옴표를 자유롭게 써도 됩니다 — JSON이 아니므로 이스케이프가 필요 없습니다).

<<<LEDE>>>
리포트 핵심 발견을 1~2문장으로 요약 (한 문단, 줄바꿈 없이)
<<<SECTION:섹션 제목1>>>
섹션 본문 HTML (여러 줄 가능)
<<<SECTION:섹션 제목2>>>
섹션 본문 HTML
<<<SOURCES>>>
출처 제목1|https://링크1
출처 제목2|https://링크2
<<<END>>>

- 섹션은 4~5개 (네이버 조사 / 웹문서검색·시장 맥락(=구글 대체, naver_webkr_as_web_context 기반) / 갭 분석 / 개선 제안 / 경쟁사 대조 순서 권장, 데이터가 부족한 섹션은 생략 가능)
- <<<SOURCES>>> 블록은 원시 데이터에 실제 있는 링크만, 한 줄에 "제목|URL" 형식으로 나열 (출처가 없으면 이 블록 자체를 생략)
- <<<END>>>으로 반드시 마무리

## 섹션 본문 HTML 작성 규칙 (아래 클래스만 사용, 인라인 style 금지)
- 일반 문단: <p>...</p>
- 한 줄 핵심 지표: <div class="stat-line ok|warn|neutral">확정 노출 <b>3건 / 20건</b></div> (ok=긍정적, warn=부정적/취약, neutral=중립)
- 표: 반드시 <div class="table-scroll"><table><thead>...<tbody>...</table></div>로 감싸고, 숫자 칸에는 <td class="num">
- 표에서 강조할 행: <tr class="row-highlight-jade">(긍정/기회) 또는 <tr class="row-highlight-clay">(부정/취약)
- 라벨: <span class="badge high|zero|low">텍스트</span>
- 핵심 인사이트: <div class="callout"><span class="callout-label">해석</span><p>...</p></div>, 부정적 신호는 <div class="callout warn">
- 개선 제안 섹션(우선순위)은: <div class="priority-list"><div class="priority-item first"><div class="priority-num">01</div><div class="priority-body"><span class="first-label">최우선</span><h4>제목</h4><p>설명</p></div></div> ... 형식으로 작성`;

  const user = `키워드: ${keyword}

## 원시 데이터 (JSON)
${JSON.stringify(raw, null, 2)}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 4500,
      thinking: { type: "disabled" },
      system,
      messages: [{ role: "user", content: user }],
    }),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Anthropic API 오류 ${res.status}: ${t.slice(0, 300)}`);
  }
  const data = await res.json();
  // 이 모델은 extended thinking이 기본 활성화될 수 있어 content[0]이 "thinking" 블록으로
  // 먼저 오는 경우가 있다 — 타입으로 실제 텍스트 블록을 찾아야 한다(위에서 disabled를 요청했지만 방어적으로 유지).
  const textBlock = (data.content || []).find((b) => b.type === "text");
  const text = textBlock?.text || "";
  return parseDelimitedReport(text);
}

// JSON 대신 <<<...>>> 구분자 포맷을 파싱한다 — 섹션 본문은 순수 HTML이라 JSON
// 이스케이핑(특히 속성 큰따옴표) 문제가 원천적으로 없다.
function parseDelimitedReport(text) {
  const ledeMatch = text.match(/<<<LEDE>>>([\s\S]*?)(?=<<<SECTION:|<<<SOURCES>>>|<<<END>>>|$)/);
  const lede = (ledeMatch?.[1] || "").trim();

  const sections = [];
  const sectionRe = /<<<SECTION:([^>]*)>>>([\s\S]*?)(?=<<<SECTION:|<<<SOURCES>>>|<<<END>>>|$)/g;
  let m;
  while ((m = sectionRe.exec(text)) !== null) {
    const title = m[1].trim();
    const html = m[2].trim();
    if (title && html) sections.push({ title, html });
  }

  const sources = [];
  const sourcesMatch = text.match(/<<<SOURCES>>>([\s\S]*?)(?=<<<END>>>|$)/);
  if (sourcesMatch) {
    for (const line of sourcesMatch[1].split("\n")) {
      const l = line.trim();
      if (!l) continue;
      const idx = l.lastIndexOf("|");
      if (idx === -1) continue;
      const title = l.slice(0, idx).trim();
      const url = l.slice(idx + 1).trim();
      if (title && url) sources.push({ title, url });
    }
  }

  if (sections.length === 0) {
    throw new Error("Claude 응답에서 섹션을 찾지 못했습니다. (원문 앞부분: " + text.slice(0, 200) + ")");
  }

  return { lede, sections, sources };
}

function renderReportHtml(keyword, dateStr, report) {
  const secCount = report.sections.length;
  const toc = report.sections
    .map((s, i) => `<a href="#sec${i + 1}"><span class="n">${String(i + 1).padStart(2, "0")}</span>${escapeHtml(s.title)}</a>`)
    .join("\n    ")
    + (report.sources?.length ? `\n    <a href="#sources"><span class="n">＋</span>Sources</a>` : "");

  const sectionsHtml = report.sections
    .map(
      (s, i) => `
  <section id="sec${i + 1}">
    <div class="sec-head"><span class="sec-num">${String(i + 1).padStart(2, "0")}</span><h2>${escapeHtml(s.title)}</h2></div>
    ${s.html}
  </section>`
    )
    .join("\n");

  const sourcesHtml = report.sources?.length
    ? `
  <section id="sources">
    <div class="sec-head"><span class="sec-num">＋</span><h2>Sources</h2></div>
    <ol class="sources">
      ${report.sources
        .map(
          (s, i) =>
            `<li><span class="src-index">${String(i + 1).padStart(2, "0")}</span><a href="${escapeAttr(s.url)}" target="_blank" rel="noopener">${escapeHtml(s.title)}</a></li>`
        )
        .join("\n      ")}
    </ol>
  </section>`
    : "";

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(keyword)} 키워드 시장조사</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Serif+KR:wght@500;600;700&family=Noto+Sans+KR:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
<style>${REPORT_CSS}</style>
</head>
<body>
<div class="wrap">
  <div class="cover">
    <div class="eyebrow"><span class="dot"></span>키워드 시장조사 · 로담한의원 · 자동생성</div>
    <h1>${escapeHtml(keyword)}</h1>
    <div class="meta-row">
      <span class="chip">조사일자 <b>${dateStr}</b></span>
      <span class="chip">채널 <b>네이버 · SearchAd · AI 합성</b></span>
      <span class="chip">대상 <b>로담한의원 9개 지점</b></span>
    </div>
    <p class="lede">${escapeHtml(report.lede || "")}</p>
  </div>
  <nav class="toc" aria-label="목차">
    ${toc}
  </nav>
  ${sectionsHtml}
  ${sourcesHtml}
  <footer>
    <span>로담한의원 키워드 시장조사 · 대시보드 자동생성 (AI 합성 결과이므로 중요 수치는 원본 API 응답과 대조 권장)</span>
    <span>${dateStr}</span>
  </footer>
</div>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(s) {
  return String(s || "").replace(/"/g, "&quot;");
}

const REPORT_CSS = `
:root{
  --paper:#F4F5F0; --paper-raised:#FFFFFF; --paper-sunken:#EBEDE6;
  --ink:#1B231F; --muted:#5C6960; --faint:#8A968E;
  --jade:#2F6F5E; --jade-strong:#1F5346; --jade-soft:#E3EEE8;
  --clay:#B65C38; --clay-soft:#F6E7DE;
  --line:rgba(27,35,31,.13); --line-strong:rgba(27,35,31,.24);
  --shadow: 0 1px 2px rgba(20,26,22,.04), 0 8px 24px -12px rgba(20,26,22,.14);
}
@media (prefers-color-scheme: dark){
  :root:not([data-theme="light"]){
    --paper:#121613; --paper-raised:#1A211C; --paper-sunken:#0D110E;
    --ink:#ECEFEA; --muted:#93A199; --faint:#65726A;
    --jade:#6FC3A6; --jade-strong:#8CD4BA; --jade-soft:rgba(111,195,166,.14);
    --clay:#E38F63; --clay-soft:rgba(227,143,99,.14);
    --line:rgba(236,239,234,.14); --line-strong:rgba(236,239,234,.26);
    --shadow: 0 1px 2px rgba(0,0,0,.3), 0 8px 24px -12px rgba(0,0,0,.5);
  }
}
:root[data-theme="dark"]{
  --paper:#121613; --paper-raised:#1A211C; --paper-sunken:#0D110E;
  --ink:#ECEFEA; --muted:#93A199; --faint:#65726A;
  --jade:#6FC3A6; --jade-strong:#8CD4BA; --jade-soft:rgba(111,195,166,.14);
  --clay:#E38F63; --clay-soft:rgba(227,143,99,.14);
  --line:rgba(236,239,234,.14); --line-strong:rgba(236,239,234,.26);
  --shadow: 0 1px 2px rgba(0,0,0,.3), 0 8px 24px -12px rgba(0,0,0,.5);
}
*{box-sizing:border-box;}
html{background:var(--paper);}
body{ margin:0; background:var(--paper); color:var(--ink); font-family:"Noto Sans KR","Malgun Gothic",sans-serif; font-size:16px; line-height:1.75; }
a{ color:var(--jade-strong); }
a:hover{ color:var(--jade); }
.wrap{ max-width:880px; margin:0 auto; padding:0 24px 96px; }
.cover{ padding:56px 0 36px; border-bottom:1px solid var(--line); margin-bottom:40px; }
.eyebrow{ font-family:"JetBrains Mono",monospace; font-size:12.5px; letter-spacing:.08em; text-transform:uppercase; color:var(--jade); display:flex; align-items:center; gap:10px; margin-bottom:20px; }
.eyebrow .dot{ width:6px; height:6px; border-radius:50%; background:var(--jade); }
h1{ font-family:"Noto Serif KR",serif; font-weight:700; font-size:clamp(28px,4.5vw,40px); line-height:1.3; letter-spacing:-.01em; margin:0 0 20px; text-wrap:balance; }
.meta-row{ display:flex; flex-wrap:wrap; gap:10px; margin-bottom:24px; }
.chip{ font-family:"JetBrains Mono",monospace; font-size:12.5px; padding:5px 11px; border-radius:100px; border:1px solid var(--line-strong); color:var(--muted); background:var(--paper-raised); white-space:nowrap; }
.chip b{ color:var(--ink); font-weight:600; }
.lede{ font-size:17px; color:var(--muted); max-width:62ch; margin:0; }
.toc{ display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:1px; background:var(--line); border:1px solid var(--line); border-radius:10px; overflow:hidden; margin-bottom:48px; }
.toc a{ display:block; background:var(--paper-raised); padding:13px 15px; text-decoration:none; color:var(--ink); font-size:13.5px; }
.toc a:hover{ background:var(--jade-soft); }
.toc .n{ font-family:"JetBrains Mono",monospace; color:var(--jade); font-size:11.5px; display:block; margin-bottom:3px; }
section{ margin-bottom:56px; scroll-margin-top:24px; }
.sec-head{ display:flex; align-items:baseline; gap:14px; margin-bottom:16px; }
.sec-num{ font-family:"JetBrains Mono",monospace; font-size:14px; color:var(--jade); background:var(--jade-soft); border-radius:6px; padding:3px 9px; flex:none; }
h2{ font-family:"Noto Serif KR",serif; font-size:24px; font-weight:600; margin:0; letter-spacing:-.005em; text-wrap:balance; }
p{ margin:0 0 14px; color:var(--ink); }
strong{ font-weight:700; }
ul,ol{ margin:0 0 14px; padding-left:22px; }
li{ margin-bottom:8px; }
.stat-line{ display:inline-flex; align-items:center; gap:8px; font-size:14.5px; padding:7px 13px; border-radius:8px; margin:4px 0 16px; border:1px solid var(--line); }
.stat-line.warn{ background:var(--clay-soft); border-color:transparent; }
.stat-line.ok{ background:var(--jade-soft); border-color:transparent; }
.stat-line.neutral{ background:var(--paper-sunken); color:var(--muted); }
.stat-line b{ font-family:"JetBrains Mono",monospace; }
.table-scroll{ overflow-x:auto; border:1px solid var(--line); border-radius:10px; margin:12px 0 20px; box-shadow:var(--shadow); background:var(--paper-raised); }
table{ border-collapse:collapse; width:100%; min-width:480px; font-size:14px; }
thead th{ text-align:left; font-family:"JetBrains Mono",monospace; font-weight:500; font-size:11px; letter-spacing:.04em; text-transform:uppercase; color:var(--muted); background:var(--paper-sunken); padding:10px 14px; border-bottom:1px solid var(--line); white-space:nowrap; }
tbody td{ padding:10px 14px; border-bottom:1px solid var(--line); vertical-align:top; }
tbody tr:last-child td{ border-bottom:none; }
td.num, th.num{ font-family:"JetBrains Mono",monospace; font-variant-numeric:tabular-nums; text-align:right; }
tr.row-highlight-jade td{ background:var(--jade-soft); }
tr.row-highlight-clay td{ background:var(--clay-soft); }
.badge{ display:inline-block; font-family:"JetBrains Mono",monospace; font-size:11.5px; font-weight:700; padding:2px 8px; border-radius:5px; }
.badge.high{ background:var(--jade-soft); color:var(--jade-strong); }
.badge.zero{ background:var(--clay-soft); color:var(--clay); }
.badge.low{ background:var(--paper-sunken); color:var(--muted); }
.callout{ border-radius:10px; padding:16px 18px; margin:16px 0 20px; border-left:3px solid var(--jade); background:var(--jade-soft); }
.callout.warn{ border-left-color:var(--clay); background:var(--clay-soft); }
.callout .callout-label{ font-family:"JetBrains Mono",monospace; font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--jade-strong); margin-bottom:6px; display:block; }
.callout.warn .callout-label{ color:var(--clay); }
.callout p{ margin:0; }
.priority-list{ display:flex; flex-direction:column; gap:12px; margin:12px 0 20px; }
.priority-item{ display:grid; grid-template-columns:48px 1fr; gap:16px; padding:16px 18px; border:1px solid var(--line); border-radius:10px; background:var(--paper-raised); box-shadow:var(--shadow); }
.priority-item.first{ border-color:var(--jade); background:var(--jade-soft); }
.priority-num{ font-family:"Noto Serif KR",serif; font-size:26px; font-weight:700; color:var(--faint); line-height:1; }
.priority-item.first .priority-num{ color:var(--jade-strong); }
.priority-body h4{ margin:2px 0 6px; font-size:15px; }
.priority-body p{ margin:0; font-size:14px; color:var(--muted); }
.priority-body .first-label{ font-family:"JetBrains Mono",monospace; font-size:10.5px; color:var(--jade-strong); letter-spacing:.05em; display:block; margin-bottom:5px; }
.sources{ list-style:none; margin:0; padding:0; }
.sources li{ padding:10px 0; border-bottom:1px solid var(--line); font-size:13.5px; }
.sources li:last-child{ border-bottom:none; }
.sources a{ color:var(--ink); text-decoration:none; }
.sources a:hover{ color:var(--jade-strong); text-decoration:underline; }
.sources .src-index{ font-family:"JetBrains Mono",monospace; color:var(--faint); margin-right:10px; font-size:12px; }
footer{ margin-top:64px; padding-top:20px; border-top:1px solid var(--line); color:var(--faint); font-size:12.5px; display:flex; justify-content:space-between; flex-wrap:wrap; gap:8px; }
`;

export default async function handler(req, res) {
  if (req.method === "GET") {
    res.status(200).json({
      ok: true,
      usage: "POST { keyword: string } 로 요청하세요.",
      env_check: {
        ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
        NAVER_CLIENT_ID: !!process.env.NAVER_CLIENT_ID,
        NAVER_CLIENT_SECRET: !!process.env.NAVER_CLIENT_SECRET,
        NAVER_AD_API_KEY: !!process.env.NAVER_AD_API_KEY,
        NAVER_AD_SECRET_KEY: !!process.env.NAVER_AD_SECRET_KEY,
        NAVER_AD_CUSTOMER_ID: !!process.env.NAVER_AD_CUSTOMER_ID,
      },
      note: "값은 노출하지 않고 설정 여부(true/false)만 표시합니다. false인 항목은 이 Vercel 프로젝트의 현재 배포에 해당 환경변수가 전달되지 않은 것입니다 — Settings에서 등록/환경 범위 확인 후 Redeploy 필요.",
    });
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST만 지원합니다." });
    return;
  }

  const keyword = (req.body?.keyword || "").toString().trim();
  if (!keyword || keyword.length > 40) {
    res.status(400).json({ error: "keyword가 비어있거나 너무 깁니다(40자 이하)." });
    return;
  }

  try {
    // 구글 Custom Search API는 프로젝트/결제 계정 설정 문제(PERMISSION_DENIED)로 비활성화함.
    // 필요해지면 googleSearch(...) 호출 두 줄을 다시 추가하면 된다 (함수 자체는 남겨둠).
    const [blog, cafe, kin, local, brandBlog, brandCafe, searchAd, webkr] = await Promise.all([
      naverSearch("blog", keyword, 15, "sim"),
      naverSearch("cafearticle", keyword, 15, "sim"),
      naverSearch("kin", keyword, 10, "sim"),
      naverSearch("local", keyword, 5, "comment"),
      naverSearch("blog", `로담한의원 ${keyword}`, 10, "sim"),
      naverSearch("cafearticle", `로담한의원 ${keyword}`, 10, "sim"),
      naverSearchAdVolume([keyword, "로담한의원", "새살침"]),
      naverSearch("webkr", keyword, 15, "sim"),
    ]);

    const raw = {
      keyword,
      naver_blog_keyword_only: blog,
      naver_cafe_keyword_only: cafe,
      naver_kin: kin,
      naver_local: local,
      naver_blog_brand_qualified: brandBlog,
      naver_cafe_brand_qualified: brandCafe,
      naver_searchad_volume: searchAd,
      // 실제 구글 검색은 서버리스 환경에서 호출할 수 없어(Custom Search API 설정 이슈로 비활성화),
      // 네이버 오픈API의 "웹문서검색"으로 대체한다 — 네이버 자체 웹 인덱스라 구글과 다를 수 있음을 명시할 것.
      naver_webkr_as_web_context: webkr,
    };

    const report = await callClaude(keyword, raw);
    const dateStr = new Date().toISOString().slice(0, 10);
    const html = renderReportHtml(keyword, dateStr, report);

    // 대시보드 목록에 남기기 위해 Vercel Blob에 저장(같은 키워드+날짜면 덮어씀).
    // 저장 실패는 조사 자체를 실패시키지 않는다 — 사용자에게는 결과를 그대로 보여준다.
    const pathname = `reports/${sanitizeForFilename(keyword)}_${dateStr}.html`;
    let saved = false;
    try {
      await put(pathname, html, {
        access: "private",
        contentType: "text/html; charset=utf-8",
        addRandomSuffix: false,
        allowOverwrite: true,
      });
      saved = true;
    } catch (e) {
      console.error("blob save failed:", e.message);
    }

    res.status(200).json({ ok: true, keyword, date: dateStr, html, raw, saved, pathname: saved ? pathname : undefined });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
}
