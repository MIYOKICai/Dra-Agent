/**
 * 连线逻辑快速验证：多入边允许 / 重复连线拒绝 / 成环拒绝 / input 拒绝入边。
 * 运行：npx tsx scripts/connect.test.ts
 */
import { useCanvasStore } from '../src/store/canvasStore';

let passed = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exitCode = 1;
  } else {
    passed++;
    console.log(`✓ ${msg}`);
  }
}

const s = useCanvasStore.getState();
useCanvasStore.setState({ nodes: [], edges: [] });

// 造 4 个节点：input → llm1 / llm2 → output
s.addNode('input', { x: 0, y: 0 });
s.addNode('llm', { x: 300, y: 0 });
s.addNode('llm', { x: 300, y: 200 });
s.addNode('output', { x: 600, y: 0 });
const nodes = useCanvasStore.getState().nodes;
const [input, llm1, llm2, output] = nodes;

// 1. 两个不同来源连到 output 同一目标句柄 → 都应保留
s.onConnect({ source: llm1.id, target: output.id, sourceHandle: null, targetHandle: null });
s.onConnect({ source: llm2.id, target: output.id, sourceHandle: null, targetHandle: null });
const e1 = useCanvasStore.getState().edges.filter((e) => e.target === output.id);
assert(e1.length === 2, `同一目标句柄可接多条入边（实际 ${e1.length} 条）`);

// 2. 完全相同的连线 → 拒绝（toast），数量不变
s.onConnect({ source: llm1.id, target: output.id, sourceHandle: null, targetHandle: null });
const e2 = useCanvasStore.getState().edges.filter((e) => e.target === output.id);
assert(e2.length === 2, '重复连线被拒绝');

// 3. 成环拒绝：llm1 → input 会成环（input → llm1? 无；改为 output → llm1 不成环…直接测 input 出边成环）
// 构造 input→llm1 已存在吗？当前没有，先连 input→llm1，再连 llm1→input 应成环拒绝
s.onConnect({ source: input.id, target: llm1.id, sourceHandle: null, targetHandle: null });
s.onConnect({ source: llm1.id, target: input.id, sourceHandle: null, targetHandle: null });
assert(!useCanvasStore.getState().edges.some((e) => e.source === llm1.id && e.target === input.id), '成环连线被拒绝');

// 4. input 节点拒绝入边
s.onConnect({ source: llm2.id, target: input.id, sourceHandle: null, targetHandle: null });
assert(!useCanvasStore.getState().edges.some((e) => e.target === input.id), 'input 节点入边被拒绝');

// 5. output 节点拒绝出边
s.onConnect({ source: output.id, target: llm1.id, sourceHandle: null, targetHandle: null });
assert(!useCanvasStore.getState().edges.some((e) => e.source === output.id), 'output 节点出边被拒绝');

console.log(`\n通过 ${passed} 项`);
if (process.exitCode === 1) process.exit(1);
