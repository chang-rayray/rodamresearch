// 대시보드에서 자동 조사되어 Vercel Blob에 저장된 리포트 목록을 반환한다.
// 파일명 규칙: reports/{키워드}_{YYYY-MM-DD}.html

import { list } from "@vercel/blob";

export const config = { runtime: "nodejs" };

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "GET만 지원합니다." });
    return;
  }

  try {
    const { blobs } = await list({ prefix: "reports/" });
    const items = blobs
      .map((b) => {
        const m = b.pathname.match(/^reports\/(.+)_(\d{4}-\d{2}-\d{2})\.html$/);
        if (!m) return null;
        return { keyword: m[1], date: m[2], pathname: b.pathname, uploadedAt: b.uploadedAt };
      })
      .filter(Boolean)
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

    res.status(200).json({ ok: true, items });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
}
