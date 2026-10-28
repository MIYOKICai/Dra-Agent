/**
 * 端到端验证：直接对网关模拟执行器的请求序列（不经过 UI）。
 * 覆盖：健康检查、模型清单、chat SSE 流（LLM/Agent 节点将发出的请求形态）、
 * 主动取消（AbortController）、图像生成、vite 代理链路。
 * 运行：node scripts/e2e-gateway.mjs（需先启动 server:3001 与 client dev:5173）
 */

const DIRECT = 'http://localhost:3001';
const PROXY = 'http://localhost:5173';

let passed = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ok  ${name}`);
  } else {
    failures.push(name);
    console.error(`FAIL  ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

/** 解析 SSE 响应：逐行取 data: 前缀的 JSON 事件（与 client/src/api/client.ts parseSSELine 同规则） */
async function consumeSSE(res, onEvent, signal) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        try {
          onEvent(JSON.parse(line.slice(5).trim()));
        } catch {
          /* 忽略非法行 */
        }
      }
    }
  } finally {
    reader.releaseLock?.();
  }
  void signal;
}

async function main() {
  console.log('== 1. 直连网关 3001 ==');

  const health = await fetch(`${DIRECT}/api/health`).then((r) => r.json());
  check('GET /api/health ok', health && health.ok === true);

  const models = await fetch(`${DIRECT}/api/models`).then((r) => r.json());
  const mock = (models.providers ?? []).find((p) => p.id === 'mock');
  check('GET /api/models 含 mock 且 available', Boolean(mock && mock.available === true));
  const chatModel = mock?.models?.find((m) => m.kind.includes('chat'))?.id;

  console.log('== 2. /api/chat SSE（模拟 LLM 节点请求：system+user+temperature） ==');
  const chatRes = await fetch(`${DIRECT}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: 'mock',
      model: chatModel ?? 'mock-chat',
      messages: [
        { role: 'system', content: '你是一个乐于助人的 AI 助手。' },
        { role: 'user', content: '模板变量已插值：请演示流式输出' },
      ],
      temperature: 0.7,
    }),
  });
  check('POST /api/chat HTTP 200', chatRes.ok && Boolean(chatRes.body));

  const events = [];
  await consumeSSE(chatRes, (ev) => events.push(ev));
  const deltas = events.filter((e) => e.type === 'delta');
  const text = deltas.map((e) => e.text).join('');
  const hasError = events.some((e) => e.type === 'error');
  check('收到 delta 事件流', deltas.length > 0, `events=${JSON.stringify(events.slice(0, 3))}`);
  check('累积文本含演示回复标记', text.includes('演示模式'), `text=${text.slice(0, 80)}`);
  check('无 error 事件', !hasError);
  check('收到 done 事件（finishReason=stop）', events.some((e) => e.type === 'done' && e.finishReason === 'stop'));

  console.log('== 3. /api/chat 主动取消（执行器 cancelRun 语义） ==');
  const abortController = new AbortController();
  let aborted = false;
  const cancelRes = await fetch(`${DIRECT}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: 'mock',
      model: chatModel ?? 'mock-chat',
      messages: [{ role: 'user', content: '这条消息会被中途取消' }],
    }),
    signal: abortController.signal,
  });
  try {
    await consumeSSE(cancelRes, () => {
      if (!aborted) {
        aborted = true;
        abortController.abort();
      }
    });
  } catch (err) {
    check('abort 后请求以 AbortError 终止', err instanceof Error && err.name === 'AbortError', String(err));
  }
  check('首 delta 后 abort 生效', aborted);

  console.log('== 4. /api/image（模拟 image 节点请求：prompt/size/count） ==');
  const imgRes = await fetch(`${DIRECT}/api/image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: 'mock',
      model: 'mock-image',
      prompt: '一只赛博朋克风格的猫',
      size: '1024x1024',
      count: 2,
    }),
  });
  const imgJson = await imgRes.json();
  check('POST /api/image HTTP 200', imgRes.ok);
  check('返回 2 张图（count 生效）', Array.isArray(imgJson.images) && imgJson.images.length === 2);
  check(
    '图片为 data URL（SVG）',
    Array.isArray(imgJson.images) && imgJson.images.every((u) => typeof u === 'string' && u.startsWith('data:image/'))
  );

  console.log('== 5. vite 代理链路（client dev 5173 → server 3001） ==');
  try {
    const proxyHealth = await fetch(`${PROXY}/api/health`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json());
    check('代理 GET /api/health ok', proxyHealth && proxyHealth.ok === true);

    const proxyChat = await fetch(`${PROXY}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'mock',
        model: chatModel ?? 'mock-chat',
        messages: [{ role: 'user', content: '经 vite 代理的流式请求' }],
      }),
    });
    const proxyEvents = [];
    await consumeSSE(proxyChat, (ev) => proxyEvents.push(ev));
    check(
      '代理 chat 收到 delta + done',
      proxyEvents.some((e) => e.type === 'delta') && proxyEvents.some((e) => e.type === 'done')
    );
  } catch (err) {
    check('vite 代理可达（client dev 是否已启动）', false, String(err));
  }

  console.log('');
  if (failures.length > 0) {
    console.error(`${failures.length} 项失败：${failures.join('、')}`);
    process.exit(1);
  }
  console.log(`端到端验证全部通过：${passed} 项`);
}

main().catch((err) => {
  console.error('脚本异常：', err);
  process.exit(1);
});
