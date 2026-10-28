/** 文件上传节点配置：只读文件清单（上传 / 删除在节点卡片上完成），说明引用方式 */
import { readFileConfig } from '../../nodes/nodeConfigs';
import type { NodeConfigFormProps } from './types';

const KIND_LABELS: Record<string, string> = {
  pdf: 'PDF',
  doc: 'DOC',
  docx: 'DOCX',
  txt: 'TXT',
  image: '图片',
};

const EXTRACT_LABELS: Record<string, string> = {
  pending: '解析中…',
  done: '已解析',
  failed: '解析失败',
};

export function FileConfig({ data }: NodeConfigFormProps) {
  const config = readFileConfig(data.config);

  return (
    <div className="space-y-3">
      <div>
        <p className="text-xs font-medium text-ink">已上传文件（{config.files.length}）</p>
        {config.files.length === 0 ? (
          <p className="mt-2 rounded-lg border border-dashed border-line bg-wash-faint px-3 py-4 text-center text-xs text-ink-muted">
            尚未上传文件：请在画布节点上拖入，或点击节点上传
            <br />
            支持 PDF / DOC / DOCX / TXT / Markdown / 图片（≤20MB）
          </p>
        ) : (
          <ul className="mt-2 space-y-1">
            {config.files.map((f) => (
              <li
                key={f.id}
                className="flex items-center gap-2 rounded-lg border border-line bg-base px-2 py-1.5"
              >
                <span className="shrink-0 rounded bg-wash-strong px-1.5 py-0.5 font-mono text-[10px] text-ink">
                  {KIND_LABELS[f.kind] ?? f.kind}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs text-ink" title={f.name}>
                  {f.name}
                </span>
                <span
                  className={`shrink-0 text-[10px] ${
                    f.extract === 'failed' ? 'text-ink' : 'text-ink-muted'
                  }`}
                  title={f.extractError}
                >
                  {EXTRACT_LABELS[f.extract] ?? f.extract}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="text-xs leading-relaxed text-ink-muted">
        运行时：文档输出服务端提取的正文文本，图片输出原图；下游节点用{' '}
        <code className="rounded bg-wash-strong px-1 font-mono text-ink">{`{{${data.label}}}`}</code>{' '}
        引用。文件解析失败不影响其余文件输出。
      </p>
    </div>
  );
}
