/**
 * SimulationNodesPanel - Manages the Simulation Nodes panel
 *
 * This panel handles:
 * - Displaying available simulation nodes
 * - Node selection and switching
 * - Node information display (status, time, server ID)
 * - Refresh and add node actions
 *
 * Communication with Python backend:
 * - Emits: 'get_nodes', 'set_active_node', 'add_nodes'
 * - Receives: 'node_info' event with NodeInfo data
 */

import { BasePanel } from '../BasePanel';
import { NodeInfo, NodeData } from '../../../data/types';
import { SocketManager } from '../../../core/SocketManager';
import { logger } from '../../../utils/Logger';

/** Cached element references for one rendered node item, keyed by node ID. */
interface NodeItemRefs {
    root: HTMLElement;
    alias: HTMLElement;
    badge: HTMLElement;
    status: HTMLElement;
    time: HTMLElement;
    idLine: HTMLElement;
}

export class SimulationNodesPanel extends BasePanel {
    private socketManager: SocketManager | null = null;
    private nodeData: NodeInfo | null = null;
    private nodeItems: Map<string, NodeItemRefs> = new Map();

    // DOM elements
    private totalNodesSpan: HTMLElement | null = null;
    private activeNodeSpan: HTMLElement | null = null;
    private nodeSelector: HTMLSelectElement | null = null;
    private nodeList: HTMLElement | null = null;
    private refreshButton: HTMLElement | null = null;
    private addNodeButton: HTMLElement | null = null;

    constructor() {
        super('.node-panel', 'simulation-nodes-content');
    }

    /**
     * Initialize the panel and set up event listeners
     */
    protected onInit(): void {
        // Get DOM elements
        this.totalNodesSpan = this.getElementById('total-nodes');
        this.activeNodeSpan = this.getElementById('active-node-display');
        this.nodeSelector = this.getElementById('node-selector') as HTMLSelectElement;
        this.nodeList = this.getElementById('node-list');
        this.refreshButton = this.getElementById('refresh-nodes');
        this.addNodeButton = this.getElementById('add-node');

        // Set up event listeners
        this.setupEventListeners();

        logger.debug('SimulationNodesPanel', 'SimulationNodesPanel initialized');
    }

    /**
     * Set up event listeners for panel controls
     */
    private setupEventListeners(): void {
        // Node selector dropdown
        if (this.nodeSelector) {
            this.addEventListener(this.nodeSelector, 'change', (e) => {
                const target = e.target as HTMLSelectElement;
                this.switchNode(target.value);
            });
        }

        // Refresh button
        if (this.refreshButton) {
            this.addEventListener(this.refreshButton, 'click', () => {
                this.refreshNodes();
            });
        }

        // Add node button
        if (this.addNodeButton) {
            this.addEventListener(this.addNodeButton, 'click', () => {
                this.showAddNodeModal();
            });
        }
    }

    /**
     * Set the socket manager for communication with backend
     */
    public setSocketManager(socketManager: SocketManager): void {
        this.socketManager = socketManager;

        // Subscribe to node_info events
        const socket = socketManager.getSocket();
        if (socket) {
            socket.on('node_info', (data: NodeInfo) => {
                this.handleNodeInfo(data);
            });
        }
    }

    /**
     * Handle node info updates from backend
     */
    private handleNodeInfo(data: NodeInfo): void {
        logger.debug('SimulationNodesPanel', 'Received node info:', data);

        // Store node data
        this.nodeData = data;

        // Update display
        this.updateNodeDisplay();
    }

    /**
     * Update the node display UI
     */
    private updateNodeDisplay(): void {
        if (!this.nodeData) return;

        // Update total nodes count
        if (this.totalNodesSpan) {
            this.totalNodesSpan.textContent = String(this.nodeData.total_nodes || 0);
        }

        // Update active node display
        this.updateActiveNodeDisplay();

        // Update node selector dropdown
        this.updateNodeSelector();

        // Update detailed node list
        this.updateNodeList();
    }

    /**
     * Update the active node display
     */
    private updateActiveNodeDisplay(): void {
        if (!this.activeNodeSpan || !this.nodeData) return;

        if (this.nodeData.active_node) {
            const activeNodeData = this.nodeData.nodes[this.nodeData.active_node];
            if (activeNodeData) {
                // Show server ID in hex format
                const serverDisplay = activeNodeData.server_id_hex ||
                                    activeNodeData.server_id ||
                                    'Unknown';
                this.activeNodeSpan.textContent = serverDisplay;
            } else {
                this.activeNodeSpan.textContent = 'Unknown';
            }
        } else {
            this.activeNodeSpan.textContent = 'None';
        }
    }

    /**
     * Update the node selector dropdown
     */
    private updateNodeSelector(): void {
        if (!this.nodeSelector || !this.nodeData) return;

        const selector = this.nodeSelector;
        const hasNodes = this.nodeData.total_nodes > 0;
        selector.disabled = !hasNodes;

        const desired: Array<{ value: string; label: string }> = hasNodes
            ? Object.entries(this.nodeData.nodes).map(([nodeId, nodeData]) => ({
                value: nodeId,
                label: `${this.getNodeAlias(nodeData)} - ${this.getScenarioName(nodeData.status)}`,
            }))
            : [{ value: '', label: 'No nodes available' }];

        // Reuse existing <option> elements in place so the open dropdown and
        // current selection aren't disturbed on every update
        desired.forEach(({ value, label }, index) => {
            let option = selector.options[index];
            if (!option) {
                option = document.createElement('option');
                selector.appendChild(option);
            }
            if (option.value !== value) option.value = value;
            if (option.textContent !== label) option.textContent = label;
        });
        while (selector.options.length > desired.length) {
            selector.remove(selector.options.length - 1);
        }

        const activeNode = hasNodes ? this.nodeData.active_node || '' : '';
        if (activeNode && selector.value !== activeNode) {
            selector.value = activeNode;
        }
    }

    /**
     * Update the detailed node list
     */
    private updateNodeList(): void {
        if (!this.nodeList || !this.nodeData) return;

        const nodeList = this.nodeList;
        const entries = Object.entries(this.nodeData.nodes || {});
        const currentIds = new Set(entries.map(([nodeId]) => nodeId));

        // Remove items for nodes that no longer exist
        this.nodeItems.forEach((item, nodeId) => {
            if (!currentIds.has(nodeId)) {
                item.root.remove();
                this.nodeItems.delete(nodeId);
            }
        });

        // Update existing items in place; create only genuinely new ones.
        // Existing elements are never destroyed, so clicks land reliably
        // and there is no visual flicker on periodic updates.
        entries.forEach(([nodeId, nodeData], index) => {
            let item = this.nodeItems.get(nodeId);
            if (!item) {
                item = this.createNodeItem(nodeId);
                this.nodeItems.set(nodeId, item);
            }
            this.updateNodeItem(item, nodeId, nodeData);

            // Only touch the DOM if the item isn't already in position
            if (nodeList.children[index] !== item.root) {
                nodeList.insertBefore(item.root, nodeList.children[index] || null);
            }
        });
    }

    /**
     * Create the skeleton of a node item element. Data is filled in by
     * updateNodeItem so the same element can be reused across updates.
     */
    private createNodeItem(nodeId: string): NodeItemRefs {
        const root = document.createElement('div');
        root.className = 'node-item';
        root.innerHTML = `
            <div class="node-header">
                <strong></strong>
                <span class="active-badge" hidden>Active</span>
            </div>
            <div class="node-details">
                <div class="node-status"></div>
                <div class="node-time"></div>
                <div class="node-id"></div>
            </div>
        `;

        // Make clickable to switch nodes
        root.addEventListener('click', () => {
            this.switchNode(nodeId);
        });

        return {
            root,
            alias: root.querySelector('strong') as HTMLElement,
            badge: root.querySelector('.active-badge') as HTMLElement,
            status: root.querySelector('.node-status') as HTMLElement,
            time: root.querySelector('.node-time') as HTMLElement,
            idLine: root.querySelector('.node-id') as HTMLElement,
        };
    }

    /**
     * Refresh a node item's content in place
     */
    private updateNodeItem(item: NodeItemRefs, nodeId: string, nodeData: NodeData): void {
        const isActive = nodeId === this.nodeData?.active_node;
        item.root.classList.toggle('active-node', isActive);
        item.badge.hidden = !isActive;

        this.setTextIfChanged(item.alias, this.getNodeAlias(nodeData));
        this.setTextIfChanged(item.status, `Status: ${this.getScenarioName(nodeData.status)}`);
        this.setTextIfChanged(item.time, `Time: ${nodeData.time || '--:--:--'}`);
        this.setTextIfChanged(item.idLine, `Node ID: ${String(nodeId || 'Unknown')}`);
    }

    /**
     * Set an element's text only when it changed, to avoid needless reflows
     */
    private setTextIfChanged(element: HTMLElement, text: string): void {
        if (element.textContent !== text) {
            element.textContent = text;
        }
    }

    /**
     * Get user-friendly node alias
     */
    private getNodeAlias(nodeData: NodeData): string {
        const nodeNum = nodeData.node_num || 1;
        return `Node ${nodeNum}`;
    }

    /**
     * Get scenario display name
     */
    private getScenarioName(status: string | undefined): string {
        if (!status || status === 'init') {
            return 'Ready';
        }
        return status;
    }

    /**
     * Switch to a different node
     */
    private switchNode(nodeId: string): void {
        if (!nodeId || !this.socketManager) {
            return;
        }

        const socket = this.socketManager.getSocket();
        if (!socket || !socket.connected) {
            logger.warn('SimulationNodesPanel', 'Cannot switch node: not connected');
            return;
        }

        // Get friendly node name for logging
        const nodeData = this.nodeData?.nodes[nodeId];
        const friendlyName = nodeData ? `Node ${nodeData.node_num || 1}` : nodeId;

        logger.info('SimulationNodesPanel', 'Switching to node:', friendlyName);

        // Emit node switch event to backend
        socket.emit('set_active_node', { node_id: nodeId });

        // Log to console (if available)
        this.logToConsole(`Switching to node: ${friendlyName}`);
    }

    /**
     * Refresh node list from backend
     */
    private refreshNodes(): void {
        if (!this.socketManager) {
            logger.warn('SimulationNodesPanel', 'Cannot refresh nodes: SocketManager not set');
            return;
        }

        const socket = this.socketManager.getSocket();
        if (!socket || !socket.connected) {
            logger.warn('SimulationNodesPanel', 'Cannot refresh nodes: not connected');
            this.logToConsole('ERROR: Not connected to BlueSky server', true);
            return;
        }

        logger.info('SimulationNodesPanel', 'Refreshing node list');
        socket.emit('get_nodes');
        this.logToConsole('Refreshing node list...');
    }

    /**
     * Add a new node to the simulation
     */
    private showAddNodeModal(): void {
        if (!this.socketManager) {
            logger.warn('SimulationNodesPanel', 'Cannot add node: SocketManager not set');
            return;
        }

        const socket = this.socketManager.getSocket();
        if (!socket || !socket.connected) {
            logger.warn('SimulationNodesPanel', 'Cannot add node: not connected');
            this.logToConsole('ERROR: Not connected to BlueSky server', true);
            return;
        }

        logger.info('SimulationNodesPanel', 'Adding new node');
        socket.emit('add_nodes', { count: 1 });
        this.logToConsole('Adding new simulation node...');
    }

    /**
     * Log message to console (if console is available)
     */
    private logToConsole(message: string, isError: boolean = false): void {
        // Access global console UI if available
        window.console_ui?.addMessage(message, isError ? 'console-error' : undefined);
    }

    /**
     * Update panel with new data
     */
    public update(data?: NodeInfo): void {
        if (data) {
            this.handleNodeInfo(data);
        }
    }

    /**
     * Get current node data
     */
    public getNodeData(): NodeInfo | null {
        return this.nodeData;
    }

    /**
     * Get active node ID
     */
    public getActiveNode(): string | null {
        return this.nodeData?.active_node || null;
    }

    /**
     * Cleanup
     */
    protected override onDestroy(): void {
        // Unsubscribe from socket events
        if (this.socketManager) {
            const socket = this.socketManager.getSocket();
            if (socket) {
                socket.off('node_info');
            }
        }

        this.nodeData = null;
        this.socketManager = null;
        this.nodeItems.clear();
    }
}
