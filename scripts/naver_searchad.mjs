#!/usr/bin/env node
// 네이버 검색광고(SearchAd) API - 키워드 도구(월간 검색수 PC/모바일) 조회
// naver-search-mcp가 이 API를 지원하지 않아 직접 호출하는 스크립트.
// 사용법: node scripts/naver_searchad.mjs 키워드1 키워드2 ...
// 자격증명은 .env.searchad 파일(프로젝트 루트)에서 읽음:
//   NAVER_AD_API_KEY=...
//   NAVER_AD_SECRET_KEY=...
//   NAVER_AD_CUSTOMER_ID=...

import { createHmac } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, "..", ".env.searchad");

function loadEnv(path) {
  const env = {};
  if (!existsSync(path)) return env;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return env;
}

const env = { ...loadEnv(envPath), ...process.env };
const API_KEY = env.NAVER_AD_API_KEY;
const SECRET_KEY = env.NAVER_AD_SECRET_KEY;
const CUSTOMER_ID = env.NAVER_AD_CUSTOMER_ID;

if (!API_KEY || !SECRET_KEY || !CUSTOMER_ID) {
  console.error(
    "자격증명이 없습니다. 프로젝트 루트에 .env.searchad 파일을 만들고 다음 값을 채워주세요:\n" +
      "NAVER_AD_API_KEY=...\nNAVER_AD_SECRET_KEY=...\nNAVER_AD_CUSTOMER_ID=..."
  );
  process.exit(1);
}

const keywords = process.argv.slice(2);
if (keywords.length === 0) {
  console.error("사용법: node scripts/naver_searchad.mjs 키워드1 키워드2 ...");
  process.exit(1);
}

function sign(timestamp, method, uri, secretKey) {
  const message = `${timestamp}.${method}.${uri}`;
  return createHmac("sha256", secretKey).update(message).digest("base64");
}

async function getKeywordStats(hintKeywords) {
  const method = "GET";
  const uri = "/keywordstool";
  const timestamp = Date.now().toString();
  const signature = sign(timestamp, method, uri, SECRET_KEY);

  const params = new URLSearchParams({
    hintKeywords: hintKeywords.join(","),
    showDetail: "1",
  });

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
  if (!res.ok) {
    console.error(`HTTP ${res.status} — ${text}`);
    process.exit(1);
  }
  return JSON.parse(text);
}

const data = await getKeywordStats(keywords);
const rows = (data.keywordList || []).map((k) => ({
  키워드: k.relKeyword,
  PC월간검색수: k.monthlyPcQcCnt,
  모바일월간검색수: k.monthlyMobileQcCnt,
  월평균클릭수_PC: k.monthlyAvePcClkCnt,
  월평균클릭수_모바일: k.monthlyAveMobileClkCnt,
  경쟁정도: k.compIdx,
}));

console.table(rows);
