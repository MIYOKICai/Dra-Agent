/**
 * 服务端工具注册表单测：calculator 递归下降解析器 + executeTool 统一执行入口。
 * 直接 import server 源文件（tools.ts 仅相对导入，tsx 转译时无需路径别名）。
 * 运行（client 目录下）：npx tsx scripts/tools.test.ts
 */
import assert from 'node:assert/strict';
import { evaluateExpression, executeTool } from '../../server/src/tools';

let passed = 0;
const failures: string[] = [];

async function runTest(name: string, fn: () => void | Promise<void>): Promise<void> {
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

/** 顺序执行：前一个用例完成后再运行下一个（含异步用例），末尾 await chain 后汇总 */
let chain: Promise<void> = Promise.resolve();
function test(name: string, fn: () => void | Promise<void>): void {
  chain = chain.then(() => runTest(name, fn));
}

/* =============== evaluateExpression：运算符优先级与结合性 =============== */

console.log('evaluateExpression');

test('乘加优先级：3*(7+2)^2 = 243', () => {
  assert.equal(evaluateExpression('3*(7+2)^2'), 243);
});

test('除法得小数：10/4 = 2.5', () => {
  assert.equal(evaluateExpression('10/4'), 2.5);
});

test('^ 右结合：2^3^2 = 512', () => {
  assert.equal(evaluateExpression('2^3^2'), 512);
});

test('^ 优先级高于一元负号：-2^2 = -4', () => {
  assert.equal(evaluateExpression('-2^2'), -4);
});

test('负指数：2^-3 = 0.125', () => {
  assert.equal(evaluateExpression('2^-3'), 0.125);
});

test('括号内一元负号：(1+2)*(-3) = -9', () => {
  assert.equal(evaluateExpression('(1+2)*(-3)'), -9);
});

test('取模：7%3 = 1', () => {
  assert.equal(evaluateExpression('7%3'), 1);
});

test('浮点噪音收敛（工具输出格式化）：calculator 0.1+0.2 → "0.3"', async () => {
  const result = await executeTool('calculator', '{"expression":"0.1+0.2"}');
  assert.equal(result.ok, true);
  assert.equal(result.result, '0.3');
});

test('科学计数法字面量：1.5e2 = 150', () => {
  assert.equal(evaluateExpression('1.5e2'), 150);
});

test('表达式两侧空白被容忍：  1 + 2  = 3', () => {
  assert.equal(evaluateExpression('  1 + 2  '), 3);
});

/* =============== evaluateExpression：错误输入 =============== */

test('除零抛错：1/0', () => {
  assert.throws(() => evaluateExpression('1/0'), /除数不能为零/);
});

test('取模除零抛错：10%0', () => {
  assert.throws(() => evaluateExpression('10%0'), /取模除数不能为零/);
});

test('悬空运算符抛错：1+', () => {
  assert.throws(() => evaluateExpression('1+'), /不完整/);
});

test('非法字符抛错：abc', () => {
  assert.throws(() => evaluateExpression('abc'), /非法字符/);
});

test('括号不匹配抛错：(1+2', () => {
  assert.throws(() => evaluateExpression('(1+2'), /括号不匹配/);
});

test('多余右括号抛错：1+2)', () => {
  assert.throws(() => evaluateExpression('1+2)'), /无法解析的内容/);
});

test('空表达式抛错', () => {
  assert.throws(() => evaluateExpression('   '), /表达式为空/);
});

test('溢出抛错：9^9^9', () => {
  assert.throws(() => evaluateExpression('9^9^9'), /溢出/);
});

/* =============== executeTool：统一执行入口 =============== */

console.log('executeTool');

test('calculator 求值 23*7 → 161', async () => {
  const result = await executeTool('calculator', '{"expression":"23*7"}');
  assert.deepEqual(result, { ok: true, result: '161' });
});

test('未知工具返回 ok:false', async () => {
  const result = await executeTool('noSuchTool', '{}');
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /未知工具/);
});

test('参数非合法 JSON 返回 ok:false', async () => {
  const result = await executeTool('calculator', '{expression:1+}');
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /参数解析失败/);
});

test('缺必填参数返回 ok:false', async () => {
  const result = await executeTool('calculator', '{}');
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /缺少必填参数：expression/);
});

test('非法表达式返回 ok:false 与明确错误', async () => {
  const result = await executeTool('calculator', '{"expression":"1+"}');
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /无法计算/);
});

test('getCurrentTime 无参数可用（含时间与 Unix 时间戳）', async () => {
  const result = await executeTool('getCurrentTime', '{}');
  assert.equal(result.ok, true);
  assert.match(result.result ?? '', /当前时间/);
  assert.match(result.result ?? '', /Unix 时间戳/);
});

test('getCurrentTime 空字符串参数等价于空对象', async () => {
  const result = await executeTool('getCurrentTime', '');
  assert.equal(result.ok, true);
  assert.match(result.result ?? '', /当前时间/);
});

test('searchKnowledge 占位实现返回"未检索到"', async () => {
  const result = await executeTool('searchKnowledge', '{"query":"任意","topK":3}');
  assert.equal(result.ok, true);
  assert.match(result.result ?? '', /未检索到相关内容/);
});

/* =============== 汇总 =============== */

await chain;
console.log('');
if (failures.length > 0) {
  console.error(`${failures.length} 个用例失败：${failures.join('、')}`);
  process.exit(1);
}
console.log(`全部通过：${passed} 个用例`);
