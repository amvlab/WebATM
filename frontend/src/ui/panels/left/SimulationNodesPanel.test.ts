// @vitest-environment happy-dom
/**
 * Tests for the Simulation Nodes panel: in-place DOM reconciliation of the
 * node list and selector, so periodic node_info updates neither flicker nor
 * destroy elements mid-click.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SimulationNodesPanel } from './SimulationNodesPanel';
import { NodeInfo, NodeData } from '../../../data/types';

const node = (num: number, overrides: Partial<NodeData> = {}): NodeData => ({
    node_num: num,
    status: 'init',
    time: '00:00:00',
    ...overrides,
});

const nodeInfo = (
    nodes: { [nodeId: string]: NodeData },
    activeNode: string | null = null
): NodeInfo => ({
    total_nodes: Object.keys(nodes).length,
    active_node: activeNode,
    nodes,
    servers: {},
});

describe('SimulationNodesPanel', () => {
    let panel: SimulationNodesPanel;
    let list: HTMLElement;
    let selector: HTMLSelectElement;

    const items = () => Array.from(list.querySelectorAll<HTMLElement>('.node-item'));
    const itemAliases = () =>
        items().map(el => el.querySelector('strong')?.textContent);

    beforeEach(() => {
        document.body.innerHTML = `
            <div class="node-panel">
                <div class="panel-content" id="simulation-nodes-content">
                    <div>Total Nodes: <span id="total-nodes">0</span></div>
                    <div>Server ID: <span id="active-node-display">None</span></div>
                    <select id="node-selector" disabled>
                        <option value="">No nodes available</option>
                    </select>
                    <button id="refresh-nodes">Refresh</button>
                    <button id="add-node">Add Node</button>
                    <div class="node-list" id="node-list"></div>
                </div>
            </div>
        `;
        list = document.getElementById('node-list')!;
        selector = document.getElementById('node-selector') as HTMLSelectElement;
        panel = new SimulationNodesPanel();
        panel.init();
    });

    afterEach(() => {
        panel.destroy();
        document.body.innerHTML = '';
    });

    it('renders one item per node with its details', () => {
        panel.update(nodeInfo({ a: node(1), b: node(2, { status: 'demo.scn', time: '00:01:30' }) }, 'a'));

        expect(itemAliases()).toEqual(['Node 1', 'Node 2']);
        const second = items()[1];
        expect(second.textContent).toContain('Status: demo.scn');
        expect(second.textContent).toContain('Time: 00:01:30');
        expect(second.textContent).toContain('Node ID: b');
    });

    it('reuses existing node elements across updates instead of recreating them', () => {
        panel.update(nodeInfo({ a: node(1), b: node(2) }, 'a'));
        const [first, second] = items();

        panel.update(nodeInfo({ a: node(1, { time: '00:00:05' }), b: node(2) }, 'a'));

        expect(items()[0]).toBe(first);
        expect(items()[1]).toBe(second);
        expect(first.textContent).toContain('Time: 00:00:05');
    });

    it('moves the active marker and badge without rebuilding items', () => {
        panel.update(nodeInfo({ a: node(1), b: node(2) }, 'a'));
        const [first, second] = items();
        expect(first.classList.contains('active-node')).toBe(true);
        expect(first.querySelector<HTMLElement>('.active-badge')!.hidden).toBe(false);
        expect(second.querySelector<HTMLElement>('.active-badge')!.hidden).toBe(true);

        panel.update(nodeInfo({ a: node(1), b: node(2) }, 'b'));

        expect(items()[0]).toBe(first);
        expect(first.classList.contains('active-node')).toBe(false);
        expect(first.querySelector<HTMLElement>('.active-badge')!.hidden).toBe(true);
        expect(second.classList.contains('active-node')).toBe(true);
        expect(second.querySelector<HTMLElement>('.active-badge')!.hidden).toBe(false);
    });

    it('removes items for nodes that disappear and adds new ones in order', () => {
        panel.update(nodeInfo({ a: node(1), b: node(2) }, 'a'));
        const first = items()[0];

        panel.update(nodeInfo({ a: node(1), c: node(3) }, 'a'));

        expect(itemAliases()).toEqual(['Node 1', 'Node 3']);
        expect(items()[0]).toBe(first);
    });

    it('reuses selector options in place and tracks the active node', () => {
        panel.update(nodeInfo({ a: node(1), b: node(2) }, 'a'));
        expect(selector.disabled).toBe(false);
        expect(Array.from(selector.options).map(o => o.textContent)).toEqual([
            'Node 1 - Ready',
            'Node 2 - Ready',
        ]);
        expect(selector.value).toBe('a');
        const firstOption = selector.options[0];

        panel.update(nodeInfo({ a: node(1), b: node(2, { status: 'demo.scn' }) }, 'b'));

        expect(selector.options[0]).toBe(firstOption);
        expect(selector.options[1].textContent).toBe('Node 2 - demo.scn');
        expect(selector.value).toBe('b');
    });

    it('shows the disabled placeholder when all nodes are gone', () => {
        panel.update(nodeInfo({ a: node(1) }, 'a'));
        panel.update(nodeInfo({}));

        expect(items()).toEqual([]);
        expect(selector.disabled).toBe(true);
        expect(Array.from(selector.options).map(o => o.textContent)).toEqual([
            'No nodes available',
        ]);
    });

    it('updates the summary counters', () => {
        panel.update(nodeInfo({ a: node(1, { server_id_hex: '0xAB12' }) }, 'a'));

        expect(document.getElementById('total-nodes')!.textContent).toBe('1');
        expect(document.getElementById('active-node-display')!.textContent).toBe('0xAB12');
    });
});
