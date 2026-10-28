/**
 * 语音朗读（TTS）播放器：模块级单例，同一时间只朗读一条消息。
 * 播放采用 MSE 流式（fetch ReadableStream → MediaSource 增量 appendBuffer）：
 * 首包音频到达即起播，不等整段合成完毕；浏览器不支持 MSE（audio/mpeg）时
 * 回退为整段 blob 播放。状态经 useSyncExternalStore 订阅，
 * 各消息操作行独立感知「谁在朗读 / 合成中」。
 */
import { API_BASE } from '../api/client';
import { useUiStore } from '../store/uiStore';

export interface TtsState {
  /** 正在朗读（或加载音频）的消息键；null = 空闲 */
  id: string | null;
  /** true = 正在请求/合成（尚未起播）；false = 播放中 */
  loading: boolean;
}

let state: TtsState = { id: null, loading: false };
let audio: HTMLAudioElement | null = null;
let objectUrl: string | null = null;
/** 当前音频流的读取器：停止朗读时 cancel 中断下载 */
let reader: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>> | null = null;
/** 世代号：每次新朗读/停止自增，作废在途的读取循环与播放回调 */
let epoch = 0;

const listeners = new Set<() => void>();

function setState(next: TtsState): void {
  state = next;
  listeners.forEach((l) => l());
}

export function subscribeTts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getTtsState(): TtsState {
  return state;
}

/** 停止当前朗读并释放资源（幂等；自增 epoch 使在途异步全部失效） */
function cleanup(): void {
  epoch += 1;
  if (reader) {
    reader.cancel().catch(() => {});
    reader = null;
  }
  if (audio) {
    audio.pause();
    audio.removeAttribute('src');
    audio = null;
  }
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }
  if (state.id !== null) setState({ id: null, loading: false });
}

function bindAudio(a: HTMLAudioElement, ticket: number): void {
  a.onended = () => {
    if (ticket === epoch) cleanup();
  };
  a.onerror = () => {
    if (ticket === epoch) cleanup();
  };
}

/** MSE 流式播放：边下边播，首包入队即起播 */
async function playWithMse(
  ticket: number,
  key: string,
  r: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>>,
): Promise<void> {
  const ms = new MediaSource();
  objectUrl = URL.createObjectURL(ms);
  audio = new Audio(objectUrl);
  bindAudio(audio, ticket);
  await new Promise<void>((resolve) => {
    ms.addEventListener('sourceopen', () => resolve(), { once: true });
  });
  if (ticket !== epoch) return;
  const sb = ms.addSourceBuffer('audio/mpeg');
  sb.mode = 'sequence';
  const queue: Uint8Array<ArrayBuffer>[] = [];
  let upstreamDone = false;
  let started = false;
  const flush = (): void => {
    try {
      if (sb.updating) return;
      const next = queue.shift();
      if (next) sb.appendBuffer(next);
      else if (upstreamDone && ms.readyState === 'open') ms.endOfStream();
    } catch {
      /* 已被清理/关闭：忽略 */
    }
  };
  sb.addEventListener('updateend', flush);

  for (;;) {
    const { value, done } = await r.read();
    if (ticket !== epoch) return;
    if (done) break;
    if (value) {
      queue.push(value);
      flush();
      if (!started) {
        started = true;
        setState({ id: key, loading: false }); // 首包起播：按钮从「合成中」切「停止」
        void audio?.play().catch(() => {});
      }
    }
  }
  upstreamDone = true;
  flush();
}

/** 回退：整段收完再播（不支持 MSE 的浏览器） */
async function playWithBlob(
  ticket: number,
  key: string,
  r: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>>,
): Promise<void> {
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  for (;;) {
    const { value, done } = await r.read();
    if (ticket !== epoch) return;
    if (done) break;
    if (value) chunks.push(value);
  }
  if (ticket !== epoch) return;
  objectUrl = URL.createObjectURL(new Blob(chunks, { type: 'audio/mpeg' }));
  audio = new Audio(objectUrl);
  bindAudio(audio, ticket);
  setState({ id: key, loading: false });
  try {
    await audio.play();
  } catch {
    if (ticket === epoch) cleanup();
  }
}

/**
 * 点按切换：空闲 → 合成并播放；点同一条 → 停止；点另一条 → 停旧的播新的。
 * @param key 消息唯一键（会话消息列表内索引即可，仅用于区分按钮目标）
 * @param text 朗读文本
 */
export async function toggleTts(key: string, text: string): Promise<void> {
  if (state.id === key) {
    cleanup();
    return;
  }
  cleanup();
  const ticket = ++epoch;
  setState({ id: key, loading: true });
  try {
    const res = await fetch(`${API_BASE}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok || !res.body) throw new Error(`TTS ${res.status}`);
    if (ticket !== epoch) return; // 等待期间已被新朗读/停止取代
    const r = (res.body as ReadableStream<Uint8Array<ArrayBuffer>>).getReader();
    reader = r;
    if (typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported('audio/mpeg')) {
      await playWithMse(ticket, key, r);
    } else {
      await playWithBlob(ticket, key, r);
    }
  } catch {
    if (ticket === epoch) {
      cleanup();
      useUiStore.getState().showToast('语音合成失败，请稍后重试');
    }
  }
}
