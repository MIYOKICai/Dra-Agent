/** mammoth 未内置类型声明：仅声明本项目用到的 docx 文本提取接口 */
declare module 'mammoth' {
  export interface ExtractRawTextResult {
    /** 提取出的纯文本（段落以换行分隔） */
    value: string;
    /** 转换警告 / 提示信息 */
    messages: unknown[];
  }
  export function extractRawText(input: { buffer: Buffer }): Promise<ExtractRawTextResult>;
}
