// 매시간 GitHub Actions "사이트 갱신" 을 대신 눌러 주는 Cloudflare Worker (예약 실행용)
// GitHub 의 schedule(cron) 이 안 돌아서 만들었다. Cloudflare 대시보드에서 Worker 를 만들고 이 코드를 붙여 넣는다.
// 필요한 것: Worker 비밀 변수 GH_TOKEN (GitHub 토큰, 이 저장소 Actions 읽기·쓰기 권한), Cron Trigger "17 * * * *"
const REPO = "froggy789/don_duruwa";
const WORKFLOW = "site.yml";
const BRANCH = "claude/confident-maxwell-4zhdhm";

async function dispatch(env) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "don-duruwa-cron",
    },
    body: JSON.stringify({ ref: BRANCH }),
  });
  return res.status; // 204 면 성공
}

export default {
  // 예약 시각마다 실행
  async scheduled(event, env, ctx) {
    ctx.waitUntil(dispatch(env));
  },
  // 주소로 들어가 보면 지금 바로 한 번 눌러 보고 결과를 알려준다 (설정 확인용)
  async fetch(request, env) {
    const status = await dispatch(env);
    return new Response(status === 204 ? "사이트 갱신 시작했다 개굴 (204)" : `실패했다 개굴 (${status}) — GH_TOKEN 권한을 확인해라 개굴`,
      { headers: { "content-type": "text/plain; charset=utf-8" } });
  },
};
