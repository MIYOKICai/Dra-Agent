/**
 * TTS 语音合成中转（POST /api/tts）：文本 → Edge 神经语音 mp3 流。
 * 前端无法直连 Edge TTS（WebSocket + Sec-MS-GEC 鉴权），由后端统一中转；
 * 每次请求新建合成实例（websocket 用完即弃），音频边合成边回传，长文本也能快速起播。
 */
import { Router } from 'express';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

export const ttsRouter = Router();

/** 可选中文音色（Edge 神经语音 ShortName），缺省晓晓（旁白/故事自然度最高） */
const VOICES = new Set([
  'zh-CN-XiaoxiaoNeural', // 晓晓：温柔女声
  'zh-CN-XiaoyiNeural', // 晓艺：活泼少女
  'zh-CN-YunjianNeural', // 云健：激昂男声
  'zh-CN-YunxiNeural', // 云希：沉稳男声
]);

/** 单次合成文本上限：朗读场景足够，同时防止超长请求长时间占用连接 */
const MAX_TEXT = 8000;

ttsRouter.post('/', async (req, res) => {
  const body = req.body as { text?: unknown; voice?: unknown } | undefined;
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  const voice =
    typeof body?.voice === 'string' && VOICES.has(body.voice)
      ? body.voice
      : 'zh-CN-XiaoxiaoNeural';
  if (!text) {
    res.status(400).json({ ok: false, error: '缺少朗读文本' });
    return;
  }
  try {
    const tts = new MsEdgeTTS({ enableLogger: false });
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(text.slice(0, MAX_TEXT));
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.flushHeaders(); // 立即发出响应头：前端 fetch 尽快 resolve，进入流式读取
    audioStream.pipe(res);
    // 响应结束（含客户端中止朗读）：关闭 websocket，避免连接悬挂
    req.on('close', () => tts.close());
  } catch (err) {
    console.error('[tts] synthesis failed:', err);
    if (!res.headersSent) {
      res.status(502).json({ ok: false, error: '语音合成失败，请稍后重试' });
    } else {
      res.end();
    }
  }
});
