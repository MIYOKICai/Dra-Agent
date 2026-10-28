/**
 * 引擎纯函数单测：topoSort / upstreamMap / interpolate / evaluateCondition / collectOutput。
 * 运行（client 目录下）：npx tsx scripts/engine.test.ts
 * graph.ts 对 @shared/types 仅 import type，tsx 转译时直接剥离，无需路径别名解析。
 */
import assert from 'node:assert/strict';
import {
  collectOutput,
  evaluateCondition,
  interpolate,
  topoSort,
  upstreamMap,
} from '../src/engine/graph';

let passed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`FAIL  ${name}`);
    console.error(err instanceof Error ? err.message : err);
  }
}

/* =============== topoSort =============== */

console.log('topoSort');

test('线性链 A→B→C 保持顺序', () => {
  const nodes = [{ id: 'A' }, { id: 'B' }, { id: 'C' }];
  const edges = [
    { source: 'A', target: 'B' },
    { source: 'B', target: 'C' },
  ];
  const result = topoSort(nodes, edges);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.order, ['A', 'B', 'C']);
});

test('菱形分支：A 先于 B/C，B/C 先于 D', () => {
  const nodes = [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }];
  const edges = [
    { source: 'A', target: 'B' },
    { source: 'A', target: 'C' },
    { source: 'B', target: 'D' },
    { source: 'C', target: 'D' },
  ];
  const { order, error } = topoSort(nodes, edges);
  assert.equal(error, undefined);
  assert.equal(order.length, 4);
  assert.equal(order[0], 'A');
  assert.ok(order.indexOf('B') < order.indexOf('D'));
  assert.ok(order.indexOf('C') < order.indexOf('D'));
});

test('检测到环时 error=cycle', () => {
  const nodes = [{ id: 'A' }, { id: 'B' }];
  const edges = [
    { source: 'A', target: 'B' },
    { source: 'B', target: 'A' },
  ];
  const result = topoSort(nodes, edges);
  assert.equal(result.error, 'cycle');
});

test('自环也算环', () => {
  const result = topoSort([{ id: 'A' }], [{ source: 'A', target: 'A' }]);
  assert.equal(result.error, 'cycle');
});

test('无边的独立节点全部保留', () => {
  const nodes = [{ id: 'x' }, { id: 'y' }, { id: 'z' }];
  const result = topoSort(nodes, []);
  assert.equal(result.error, undefined);
  assert.deepEqual([...result.order].sort(), ['x', 'y', 'z']);
});

test('忽略引用不存在节点的悬挂边', () => {
  const nodes = [{ id: 'A' }, { id: 'B' }];
  const edges = [
    { source: 'A', target: 'B' },
    { source: 'ghost', target: 'A' },
    { source: 'B', target: 'ghost' },
  ];
  const result = topoSort(nodes, edges);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.order, ['A', 'B']);
});

test('空图返回空序', () => {
  const result = topoSort([], []);
  assert.deepEqual(result, { order: [] });
});

/* =============== upstreamMap =============== */

console.log('upstreamMap');

test('直接上游映射正确', () => {
  const nodes = [{ id: 'A' }, { id: 'B' }, { id: 'C' }];
  const edges = [
    { source: 'A', target: 'C' },
    { source: 'B', target: 'C' },
  ];
  const map = upstreamMap(nodes, edges);
  assert.deepEqual(map.get('A'), []);
  assert.deepEqual(map.get('B'), []);
  assert.deepEqual(map.get('C'), ['A', 'B']);
});

test('重复连线去重', () => {
  const nodes = [{ id: 'A' }, { id: 'B' }];
  const edges = [
    { source: 'A', target: 'B' },
    { source: 'A', target: 'B' },
  ];
  const map = upstreamMap(nodes, edges);
  assert.deepEqual(map.get('B'), ['A']);
});

test('所有节点都有键（含无上游节点）', () => {
  const map = upstreamMap([{ id: 'solo' }], []);
  assert.ok(map.has('solo'));
  assert.deepEqual(map.get('solo'), []);
});

/* =============== interpolate =============== */

console.log('interpolate');

test('正常替换单个占位符', () => {
  const { text, missing } = interpolate('你好，{{名字}}！', (n) => (n === '名字' ? '世界' : undefined));
  assert.equal(text, '你好，世界！');
  assert.deepEqual(missing, []);
});

test('占位符前后空白被容忍', () => {
  const { text } = interpolate('A {{  名称  }} B', (n) => (n === '名称' ? 'V' : undefined));
  assert.equal(text, 'A V B');
});

test('同一变量多次出现全部替换', () => {
  const { text } = interpolate('{{x}}+{{x}}={{x}}', (n) => (n === 'x' ? '1' : undefined));
  assert.equal(text, '1+1=1');
});

test('相邻占位符', () => {
  const { text } = interpolate('{{a}}{{b}}', (n) => (n === 'a' ? 'A' : n === 'b' ? 'B' : undefined));
  assert.equal(text, 'AB');
});

test('缺失变量：替换为空串并进入 missing 名单', () => {
  const { text, missing } = interpolate('前{{不存在}}后', () => undefined);
  assert.equal(text, '前后');
  assert.deepEqual(missing, ['不存在']);
});

test('missing 名单按首次出现顺序去重', () => {
  const { missing } = interpolate('{{b}} {{a}} {{b}} {{a}} {{c}}', () => undefined);
  assert.deepEqual(missing, ['b', 'a', 'c']);
});

test('resolve 返回空字符串不算缺失', () => {
  const { text, missing } = interpolate('[{{x}}]', () => '');
  assert.equal(text, '[]');
  assert.deepEqual(missing, []);
});

test('嵌套花括号：{{{name}}} 只解析最内层，外层保留', () => {
  const { text, missing } = interpolate('{{{name}}}', (n) => (n === 'name' ? '值' : undefined));
  assert.equal(text, '{值}');
  assert.deepEqual(missing, []);
});

test('嵌套花括号缺失时同样留空外层', () => {
  const { text, missing } = interpolate('{{{ghost}}}', () => undefined);
  assert.equal(text, '{}');
  assert.deepEqual(missing, ['ghost']);
});

test('无占位符的模板原样返回', () => {
  const { text, missing } = interpolate('普通文本 {单括号} }}{{', () => 'x');
  assert.equal(text, '普通文本 {单括号} }}{{');
  assert.deepEqual(missing, []);
});

test('替换结果不会被二次解析（防注入）', () => {
  const { text } = interpolate('{{a}}', (n) => (n === 'a' ? '{{b}}' : undefined));
  assert.equal(text, '{{b}}');
});

/* =============== evaluateCondition =============== */

console.log('evaluateCondition');

test('空关键词默认 true（命中与未命中文本一致）', () => {
  assert.equal(evaluateCondition('', false, '任何文本'), 'true');
  assert.equal(evaluateCondition('   ', true, ''), 'true');
});

test('包含关键词判 true，不包含判 false', () => {
  assert.equal(evaluateCondition('错误', false, '发生错误了'), 'true');
  assert.equal(evaluateCondition('错误', false, '一切正常'), 'false');
});

test('caseSensitive=false 不区分大小写', () => {
  assert.equal(evaluateCondition('ERROR', false, 'an Error occurred'), 'true');
  assert.equal(evaluateCondition('error', false, 'AN ERROR OCCURRED'), 'true');
});

test('caseSensitive=true 区分大小写', () => {
  assert.equal(evaluateCondition('ERROR', true, 'an Error occurred'), 'false');
  assert.equal(evaluateCondition('Error', true, 'an Error occurred'), 'true');
});

test('关键词两侧空白被修剪', () => {
  assert.equal(evaluateCondition('  通过  ', false, '审核通过'), 'true');
});

/* =============== collectOutput =============== */

console.log('collectOutput');

test('undefined 产物兜底为空', () => {
  assert.deepEqual(collectOutput(undefined), { text: '', images: [] });
});

test('只取 text 与 images，忽略 fragments/steps/branch', () => {
  const result = collectOutput({
    text: '正文',
    images: ['img1.png', 'img2.png'],
    fragments: [{ text: '片段', source: 'kb', score: 0.9 }],
    branch: 'true',
    steps: [{ kind: 'answer', content: '答' }],
  });
  assert.deepEqual(result, { text: '正文', images: ['img1.png', 'img2.png'] });
});

test('text 缺失时兜底空串，images 缺失时兜底空数组', () => {
  assert.deepEqual(collectOutput({ images: ['a'] }), { text: '', images: ['a'] });
  assert.deepEqual(collectOutput({ text: '仅文本' }), { text: '仅文本', images: [] });
});

/* =============== 汇总 =============== */

console.log('');
if (failures.length > 0) {
  console.error(`${failures.length} 个用例失败：${failures.join('、')}`);
  process.exit(1);
}
console.log(`全部通过：${passed} 个用例`);
