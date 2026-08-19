// @vitest-environment happy-dom
/**
 * Tests for the Simulation Nodes panel: in-place DOM reconciliation of the
 * node list and selector, so periodic node_info updates neither flicker nor
 * destroy elements mid-click.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SimulationNodesPanel } from './SimulationNodesPanel';
import { SocketManager } from '../../../core/SocketManager';
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

    describe('kill button', () => {
        const emitted: Array<[string, unknown]> = [];
        const fakeSocket = {
            connected: true,
            on: vi.fn(),
            off: vi.fn(),
            emit: (event: string, payload: unknown) => emitted.push([event, payload]),
        };
        const fakeSocketManager = {
            getSocket: () => fakeSocket,
        } as unknown as SocketManager;

        beforeEach(() => {
            emitted.length = 0;
            panel.setSocketManager(fakeSocketManager);
        });

        it('emits del_node after confirmation without switching the active node', () => {
            vi.stubGlobal('confirm', vi.fn(() => true));
            panel.update(nodeInfo({ a: node(1), b: node(2) }, 'a'));

            items()[1].querySelector<HTMLElement>('.node-kill-btn')!.click();

            expect(emitted).toEqual([['del_node', { node_id: 'b' }]]);
            vi.unstubAllGlobals();
        });

        it('refuses to kill the last node without asking the server', () => {
            const confirmSpy = vi.fn(() => true);
            vi.stubGlobal('confirm', confirmSpy);
            panel.update(nodeInfo({ a: node(1) }, 'a'));

            items()[0].querySelector<HTMLElement>('.node-kill-btn')!.click();

            // BlueSky's server refuses last-node deletion; the panel mirrors
            // that client-side: no confirmation prompt, nothing sent.
            expect(confirmSpy).not.toHaveBeenCalled();
            expect(emitted).toEqual([]);
            vi.unstubAllGlobals();
        });

        it('does nothing when the confirmation is declined', () => {
            vi.stubGlobal('confirm', vi.fn(() => false));
            panel.update(nodeInfo({ a: node(1), b: node(2) }, 'a'));

            items()[1].querySelector<HTMLElement>('.node-kill-btn')!.click();

            expect(emitted).toEqual([]);
            vi.unstubAllGlobals();
        });

        it('clicking the item body still switches the node', () => {
            panel.update(nodeInfo({ a: node(1), b: node(2) }, 'a'));

            items()[1].click();

            expect(emitted).toEqual([['set_active_node', { node_id: 'b' }]]);
        });
    });

    describe('socket wiring', () => {
        type Listener = (data: NodeInfo) => void;

        // Fake with socket.io off() semantics: off(event) drops every
        // listener for the event, off(event, fn) drops only fn.
        const makeFakeSocket = () => {
            const listeners = new Map<string, Set<Listener>>();
            const socket = {
                connected: true,
                on: (event: string, handler: Listener) => {
                    if (!listeners.has(event)) listeners.set(event, new Set());
                    listeners.get(event)!.add(handler);
                },
                off: (event: string, handler?: Listener) => {
                    if (handler) listeners.get(event)?.delete(handler);
                    else listeners.delete(event);
                },
                emit: vi.fn(),
            };
            return { socket, listeners };
        };

        const asManager = (socket: unknown): SocketManager =>
            ({ getSocket: () => socket }) as unknown as SocketManager;

        it('destroy() removes only its own node_info listener', () => {
            const { socket, listeners } = makeFakeSocket();
            // Stands in for SocketManager's own forward listener, which
            // shares the socket and must survive the panel's teardown.
            const outsider = vi.fn();
            socket.on('node_info', outsider);
            panel.setSocketManager(asManager(socket));
            expect(listeners.get('node_info')!.size).toBe(2);

            panel.destroy();

            const remaining = listeners.get('node_info');
            expect(remaining && [...remaining]).toEqual([outsider]);
        });

        it('re-setting the socket manager does not double-subscribe', () => {
            const { socket, listeners } = makeFakeSocket();
            const manager = asManager(socket);

            panel.setSocketManager(manager);
            panel.setSocketManager(manager);

            expect(listeners.get('node_info')!.size).toBe(1);
        });

        it('switching sockets unsubscribes from the old one', () => {
            const first = makeFakeSocket();
            const second = makeFakeSocket();

            panel.setSocketManager(asManager(first.socket));
            panel.setSocketManager(asManager(second.socket));

            expect(first.listeners.get('node_info')?.size ?? 0).toBe(0);
            expect(second.listeners.get('node_info')!.size).toBe(1);
        });
    });
});
