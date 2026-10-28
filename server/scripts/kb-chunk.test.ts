/**
 * 知识库分块与检索打分单测（Task 7）。
 * 运行（server 目录下）：npx tsx scripts/kb-chunk.test.ts
 * 环境隔离：在 import kb 模块前把 KB_DATA_DIR 指向临时目录、EMBEDDING_PROVIDER 固定为
 * mock（纯本地 64 维伪向量，不依赖网络与 API Key），保证测试确定可重复。
 */
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'dra-kb-test-'));
process.env.KB_DATA_DIR = tmpRoot;
process.env.EMBEDDING_PROVIDER = 'mock';

const {
  KBError,
  addDocument,
  bigramScore,
  chunkText,
  cosineSimilarity,
  createKB,
  deleteKB,
  listKBs,
  search,
} = await import('../src/kb');

let passed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`FAIL  ${name}`);
    console.error(err instanceof Error ? err.message : err);
  }
}

/* =============== chunkText：分块 =============== */

console.log('chunkText');

await test('短文本（≤ chunkSize）单块返回原文', () => {
  const text = '这是一段不足五百字的短文本。';
  assert.deepEqual(chunkText(text, 500, 50), [text]);
});

await test('空文本 / 纯空白返回空数组', () => {
  assert.deepEqual(chunkText('', 500, 50), []);
  assert.deepEqual(chunkText('   \n\t  ', 500, 50), []);
});

await test('长中文文本 500/50：每块 ≤ 500 字且相邻块重叠 50 字', () => {
  // 2400 个无标点汉字：无边界可对齐，退化为标准滑窗
  const text = '甲乙丙丁戊己庚辛壬癸'.repeat(240);
  const chunks = chunkText(text, 500, 50);
  assert.equal(chunks.length, 6);
  assert.ok(chunks.every((c) => c.length <= 500), '每块不超过 chunkSize');
  assert.ok(
    chunks.slice(0, -1).every((c) => c.length >= 400),
    '除末块外每块接近 chunkSize'
  );
  // 无空白文本不会被 trim 影响位置：第 2 块必须以第 1 块的尾部 50 字开头
  assert.ok(chunks[1].startsWith(chunks[0].slice(450)), 'overlap=50 位置重叠正确');
  assert.ok(chunks[2].startsWith(chunks[1].slice(450)));
  // 首尾覆盖完整：首块开头 = 原文开头，末块结尾 = 原文结尾
  assert.equal(chunks[0].slice(0, 10), text.slice(0, 10));
  assert.ok(text.endsWith(chunks[chunks.length - 1].slice(-10)));
});

await test('边界对齐：带句号的长文在句读处切分（块尾为句号）', () => {
  const sentences = Array.from(
    { length: 40 },
    (_, i) => `这是第${i + 1}句话，包含若干内容用来撑起窗口长度测试对齐。`
  );
  const text = sentences.join('');
  const chunks = chunkText(text, 80, 20);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => c.length <= 80), '对齐后每块仍不超过 chunkSize');
  assert.ok(
    chunks.slice(0, -1).every((c) => c.endsWith('。')),
    '非末块的块尾都落在句号边界上'
  );
});

await test('overlap=0 时相邻块不重叠（可无损拼回原文）', () => {
  const text = '零'.repeat(1234);
  const chunks = chunkText(text, 300, 0);
  assert.equal(chunks.join(''), text);
});

await test('overlap 过大（≥ chunkSize）被夹取，窗口仍前移不死循环', () => {
  const chunks = chunkText('字'.repeat(1000), 100, 99);
  assert.ok(chunks.length > 10);
  assert.ok(chunks.every((c) => c.length <= 100));
});

/* =============== 打分函数 =============== */

console.log('similarity');

await test('cosineSimilarity：同向 = 1，正交 = 0，维度不一致 = 0', () => {
  assert.ok(Math.abs(cosineSimilarity([3, 4], [6, 8]) - 1) < 1e-9);
  assert.ok(Math.abs(cosineSimilarity([1, 0], [0, 1])) < 1e-9);
  assert.equal(cosineSimilarity([1, 2, 3], [1, 2]), 0);
  assert.equal(cosineSimilarity([], [1]), 0);
});

await test('bigramScore：相关文本得分高于无关文本，范围 0~1', () => {
  const query = '知识库检索的工作原理';
  const related = '本节介绍知识库检索的工作原理与实现细节。';
  const unrelated = '今天天气不错，适合出门散步爬山。';
  const sRelated = bigramScore(query, related);
  const sUnrelated = bigramScore(query, unrelated);
  assert.ok(sRelated > sUnrelated, `related(${sRelated}) > unrelated(${sUnrelated})`);
  assert.ok(sRelated > 0 && sRelated <= 1);
  assert.equal(bigramScore('', related), 0);
});

/* =============== API 层：建库 / 上传 / 检索（临时目录 + mock 向量） =============== */

console.log('kb api');

await test('createKB 参数校验：非法 chunkSize / chunkOverlap 抛 400', async () => {
  await assert.rejects(
    () => createKB({ name: '坏参数', chunkSize: 50 }),
    (err: unknown) => err instanceof KBError && err.status === 400
  );
  await assert.rejects(
    () => createKB({ name: '坏参数', chunkOverlap: 300 }),
    (err: unknown) => err instanceof KBError && err.status === 400
  );
  await assert.rejects(
    () => createKB({ name: '   ' }),
    (err: unknown) => err instanceof KBError && err.status === 400
  );
});

await test('多文档上传：docCount / chunkCount 正确汇总，documents 明细一致', async () => {
  const kb = await createKB({ name: '单测库', chunkSize: 100, chunkOverlap: 20 });
  const afterDoc1 = await addDocument(kb.id, {
    name: '文档一',
    content: '甲'.repeat(420), // 100/20 滑窗 → 5 块
  });
  const afterDoc2 = await addDocument(kb.id, {
    name: '文档二',
    content: '乙'.repeat(250), // → 3 块
  });
  assert.equal(afterDoc1.docCount, 1);
  assert.equal(afterDoc1.chunkCount, 5);
  assert.equal(afterDoc2.docCount, 2);
  assert.equal(afterDoc2.chunkCount, 8);
  assert.equal(afterDoc2.documents.length, 2);
  assert.deepEqual(
    afterDoc2.documents.map((d) => d.chunkCount).sort((a, b) => a - b),
    [3, 5]
  );
  assert.equal(afterDoc2.mode, 'vector');
  await deleteKB(kb.id);
});

await test('search：命中片段非空、得分递减且在 0~1、source 为文档名', async () => {
  const kb = await createKB({ name: '检索单测库' });
  await addDocument(kb.id, {
    name: 'AI 画布指南',
    content:
      'AI 画布是一个可视化工作流编排工具。'.repeat(40) +
      '画布支持输入、模板、大模型、检索等八类节点。'.repeat(40),
  });
  const { fragments } = await search(kb.id, '工作流编排工具', 3);
  assert.ok(fragments.length > 0, '返回非空片段');
  assert.ok(fragments.every((f) => f.score >= 0 && f.score <= 1), '得分在 0~1');
  assert.ok(
    fragments.every((f, i) => i === 0 || fragments[i - 1].score >= f.score),
    '按得分降序'
  );
  assert.equal(fragments[0].source, 'AI 画布指南');
  assert.ok(fragments[0].text.length > 0);
  await deleteKB(kb.id);
});

await test('search：对不存在的库抛 KBError 404', async () => {
  await assert.rejects(
    () => search('00000000-0000-4000-8000-000000000000', '任意查询'),
    (err: unknown) => err instanceof KBError && err.status === 404
  );
});

await test('deleteKB：删除后列表不再包含，且目录被清理', async () => {
  const kb = await createKB({ name: '待删除库' });
  assert.ok((await listKBs()).some((k) => k.id === kb.id));
  await deleteKB(kb.id);
  assert.ok(!(await listKBs()).some((k) => k.id === kb.id));
  await assert.rejects(() => fsp.access(path.join(tmpRoot, kb.id)));
  await assert.rejects(
    () => deleteKB(kb.id),
    (err: unknown) => err instanceof KBError && err.status === 404
  );
});

/* =============== 收尾 =============== */

await fsp.rm(tmpRoot, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`\n${passed} passed, ${failures.length} FAILED`);
  process.exit(1);
}
console.log(`\n全部通过：${passed} 项`);
