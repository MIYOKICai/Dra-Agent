/**
 * 模板合法性自测（Task 8）：对每个预置模板断言结构与配置完整可运行。
 * 运行（client 目录下）：npx tsx scripts/templates.test.ts
 * 依赖模块（engine/graph、nodes/registry、templates、store/canvasStore）中
 * @shared/types 仅 import type，tsx 转译时剥离，无需路径别名解析。
 */
import assert from 'node:assert/strict';
import { topoSort } from '../src/engine/graph';
import { isNodeType } from '../src/nodes/registry';
import { WORKFLOW_TEMPLATES, type WorkflowTemplate } from '../src/templates';
import { WORKFLOW_VERSION } from '../src/store/canvasStore';
import type { NodeType, WorkflowEdge, WorkflowNode } from '@shared/types';

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

/** 每类节点除 provider/model/kbId 外必须非空的文本字段 */
const REQUIRED_TEXT_FIELDS: Partial<Record<NodeType, string[]>> = {
  input: ['text'],
  template: ['template'],
  llm: ['userPrompt'],
  image: ['prompt'],
  retrieval: ['query'],
  condition: ['keyword'],
  agent: ['userPrompt'],
};

/** 提取文本中全部 {{占位符}} 变量名 */
function placeholders(text: string): string[] {
  const names: string[] = [];
  const re = /\{\{\s*([^{}]+?)\s*\}\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) names.push(match[1]);
  return names;
}

/** 节点全部祖先（含间接）的 label 集合；执行器 resolveVar 只在祖先中按 label 找变量 */
function ancestorLabels(node: WorkflowNode, nodes: WorkflowNode[], edges: WorkflowEdge[]): Set<string> {
  const labelById = new Map(nodes.map((n) => [n.id, n.data.label] as const));
  const parents = new Map<string, string[]>();
  for (const e of edges) {
    if (!labelById.has(e.source) || !labelById.has(e.target)) continue;
    if (!parents.has(e.target)) parents.set(e.target, []);
    parents.get(e.target)!.push(e.source);
  }
  const labels = new Set<string>();
  const stack = [...(parents.get(node.id) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop()!;
    const label = labelById.get(id);
    if (label === undefined || labels.has(label)) continue;
    labels.add(label);
    stack.push(...(parents.get(id) ?? []));
  }
  return labels;
}

function checkTemplate(tpl: WorkflowTemplate): void {
  const wf = tpl.workflow;
  const tag = `[${tpl.name}]`;

  test(`${tag} 元信息齐全且 version=1`, () => {
    assert.ok(tpl.id.trim(), 'id 为空');
    assert.ok(tpl.name.trim(), 'name 为空');
    assert.ok(tpl.icon.trim(), 'icon 为空');
    assert.ok(tpl.description.trim(), 'description 为空');
    assert.ok(tpl.scenario.trim(), 'scenario 为空');
    assert.ok(wf.name.trim(), 'workflow.name 为空');
    assert.equal(wf.version, 1);
    assert.equal(wf.version, WORKFLOW_VERSION);
    assert.ok(wf.nodes.length >= 2, '节点过少');
    assert.ok(wf.edges.length >= 1, '缺少连线');
  });

  test(`${tag} 节点 id 唯一、type 合法、状态为 idle`, () => {
    const ids = new Set<string>();
    for (const n of wf.nodes) {
      assert.ok(n.id.trim(), '存在缺少 id 的节点');
      assert.ok(!ids.has(n.id), `节点 id 重复：${n.id}`);
      ids.add(n.id);
      assert.ok(isNodeType(n.type), `节点 ${n.id} type 非法：${String(n.type)}`);
      assert.equal(typeof n.position.x, 'number', `节点 ${n.id} position.x 非数字`);
      assert.equal(typeof n.position.y, 'number', `节点 ${n.id} position.y 非数字`);
      assert.equal(n.data.status, 'idle', `节点 ${n.id} 初始状态应为 idle`);
      assert.equal(n.data.output, undefined, `节点 ${n.id} 不应携带历史产物`);
      assert.equal(n.data.error, undefined, `节点 ${n.id} 不应携带错误信息`);
    }
  });

  test(`${tag} label 语义化且互不重复（占位符按 label 解析）`, () => {
    const labels = new Set<string>();
    for (const n of wf.nodes) {
      assert.ok(n.data.label.trim(), `节点 ${n.id} label 为空`);
      assert.ok(!labels.has(n.data.label), `label 重复：${n.data.label}`);
      labels.add(n.data.label);
    }
  });

  test(`${tag} 连线引用存在且 sourceHandle 合法`, () => {
    const byId = new Map(wf.nodes.map((n) => [n.id, n] as const));
    const edgeIds = new Set<string>();
    for (const e of wf.edges) {
      assert.ok(e.id.trim(), '存在缺少 id 的连线');
      assert.ok(!edgeIds.has(e.id), `连线 id 重复：${e.id}`);
      edgeIds.add(e.id);
      assert.ok(byId.has(e.source), `连线 ${e.id} 引用了不存在的 source：${e.source}`);
      assert.ok(byId.has(e.target), `连线 ${e.id} 引用了不存在的 target：${e.target}`);
      const sourceType = byId.get(e.source)!.type;
      if (sourceType === 'condition') {
        assert.ok(
          e.sourceHandle === 'true' || e.sourceHandle === 'false',
          `condition 连线 ${e.id} 的 sourceHandle 只能为 true/false，实际：${String(e.sourceHandle)}`
        );
      } else {
        assert.ok(
          !e.sourceHandle,
          `非 condition 连线 ${e.id} 不应带 sourceHandle：${String(e.sourceHandle)}`
        );
      }
    }
  });

  test(`${tag} 必填配置非空；provider/model/kbId 留空待回填`, () => {
    for (const n of wf.nodes) {
      for (const field of REQUIRED_TEXT_FIELDS[n.type] ?? []) {
        const value = n.data.config[field];
        assert.equal(typeof value, 'string', `节点「${n.data.label}」缺少 ${field}`);
        assert.ok((value as string).trim(), `节点「${n.data.label}」的 ${field} 为空`);
      }
      if (n.type === 'llm' || n.type === 'agent' || n.type === 'image') {
        assert.equal(n.data.config.provider, '', `节点「${n.data.label}」provider 应留空由加载回填`);
        assert.equal(n.data.config.model, '', `节点「${n.data.label}」model 应留空由加载回填`);
      }
      if (n.type === 'retrieval') {
        assert.equal(n.data.config.kbId, '', `节点「${n.data.label}」kbId 应留空由加载回填`);
        assert.equal(typeof n.data.config.topK, 'number', `节点「${n.data.label}」topK 应为数字`);
      }
      if (n.type === 'image') {
        assert.equal(typeof n.data.config.count, 'number', `节点「${n.data.label}」count 应为数字`);
      }
    }
  });

  test(`${tag} 全部占位符都能在祖先节点 label 中解析`, () => {
    for (const n of wf.nodes) {
      const texts = Object.values(n.data.config).filter((v): v is string => typeof v === 'string');
      for (const text of texts) {
        for (const name of placeholders(text)) {
          const labels = ancestorLabels(n, wf.nodes, wf.edges);
          assert.ok(
            labels.has(name),
            `节点「${n.data.label}」的占位符 {{${name}}} 找不到同名祖先节点`
          );
        }
      }
    }
  });

  test(`${tag} 无环且存在输出节点`, () => {
    const topo = topoSort(wf.nodes, wf.edges);
    assert.equal(topo.error, undefined, '工作流存在环');
    assert.equal(topo.order.length, wf.nodes.length, '拓扑序未覆盖全部节点');
    assert.ok(wf.nodes.some((n) => n.type === 'output'), '缺少输出节点');
    assert.ok(wf.nodes.some((n) => n.type === 'input'), '缺少输入节点');
  });
}

/* =============== 执行 =============== */

test('模板数量 ≥ 4', () => {
  assert.ok(WORKFLOW_TEMPLATES.length >= 4, `当前仅 ${WORKFLOW_TEMPLATES.length} 个模板`);
});

console.log(`模板合法性自测：共 ${WORKFLOW_TEMPLATES.length} 个模板`);
for (const tpl of WORKFLOW_TEMPLATES) {
  console.log(tpl.name);
  checkTemplate(tpl);
}

console.log(`\n通过 ${passed} 项`);
if (failures.length > 0) {
  console.error(`失败 ${failures.length} 项：`);
  for (const name of failures) console.error(`  - ${name}`);
  process.exit(1);
}
console.log('全部通过 ✅');
