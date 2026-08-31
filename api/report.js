// Vercel Blob(private)에 저장된 리포트 HTML을 브라우저에 스트리밍해주는 프록시.
// 프라이빗 스토어라 클라이언트가 blob URL을 직접 열 수 없어 서버가 대신 인증해서 가져온다.

import { head } from "@vercel/blob";

export const config = { runtime: "nodejs" };

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).send("GET만 지원합니다.");
    return;
  }

  const pathname = (req.query?.path || "").toString();
  if (!pathname.startsWith("reports/") || !pathname.endsWith(".html")) {
    res.status(400).send("잘못된 경로입니다.");
    return;
  }

  try {
    const meta = await head(pathname);
    const token = process.env.BLOB_READ_WRITE_TOKEN;
    const blobRes = await fetch(meta.url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!blobRes.ok) {
      res.status(blobRes.status).send("리포트를 불러오지 못했습니다.");
      return;
    }
    const html = await blobRes.text();
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(html);
  } catch (e) {
    res.status(404).send("리포트를 찾을 수 없습니다.");
  }
}
