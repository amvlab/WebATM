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

export class SimulationNodesPanel extends BasePanel {
    private socketManager: SocketManager | null = null;
    private nodeData: NodeInfo | null = null;

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

        // Clear existing options
        this.nodeSelector.innerHTML = '';

        if (this.nodeData.total_nodes === 0) {
            const option = document.createElement('option');
            option.value = '';
            option.textContent = 'No nodes available';
            this.nodeSelector.appendChild(option);
            this.nodeSelector.disabled = true;
        } else {
            this.nodeSelector.disabled = false;

            // Add nodes to selector
            Object.entries(this.nodeData.nodes).forEach(([nodeId, nodeData]) => {
                const option = document.createElement('option');
                option.value = nodeId;

                const alias = this.getNodeAlias(nodeData);
                const scenario = this.getScenarioName(nodeData.status);
                option.textContent = `${alias} - ${scenario}`;

                if (nodeId === this.nodeData!.active_node) {
                    option.selected = true;
                }

                this.nodeSelector!.appendChild(option);
            });
        }
    }

    /**
     * Update the detailed node list
     */
    private updateNodeList(): void {
        if (!this.nodeList || !this.nodeData) return;

        // Clear existing list
        this.nodeList.innerHTML = '';

        if (!this.nodeData.nodes) return;

        // Add node items
        Object.entries(this.nodeData.nodes).forEach(([nodeId, nodeData]) => {
            const nodeItem = this.createNodeItem(nodeId, nodeData);
            if (this.nodeList) {
                this.nodeList.appendChild(nodeItem);
            }
        });
    }

    /**
     * Create a node item element
     */
    private createNodeItem(nodeId: string, nodeData: NodeData): HTMLElement {
        const nodeItem = document.createElement('div');
        nodeItem.className = 'node-item';

        // Mark active node
        if (nodeId === this.nodeData?.active_node) {
            nodeItem.classList.add('active-node');
        }

        const alias = this.getNodeAlias(nodeData);
        const scenario = this.getScenarioName(nodeData.status);
        const currentTime = nodeData.time || '--:--:--';
        const displayNodeId = String(nodeId || 'Unknown');

        // Build node item HTML
        nodeItem.innerHTML = `
            <div class="node-header">
                <strong>${alias}</strong>
                ${nodeId === this.nodeData?.active_node ? '<span class="active-badge">Active</span>' : ''}
            </div>
            <div class="node-details">
                <div>Status: ${scenario}</div>
                <div>Time: ${currentTime}</div>
                <div>Node ID: ${displayNodeId}</div>
            </div>
        `;

        // Make clickable to switch nodes
        nodeItem.addEventListener('click', () => {
            this.switchNode(nodeId);
        });

        return nodeItem;
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
        const consoleUI = (window as any).console_ui;
        if (consoleUI && typeof consoleUI.addMessage === 'function') {
            consoleUI.addMessage(message, isError ? 'console-error' : undefined);
        }
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
    protected onDestroy(): void {
        // Unsubscribe from socket events
        if (this.socketManager) {
            const socket = this.socketManager.getSocket();
            if (socket) {
                socket.off('node_info');
            }
        }

        this.nodeData = null;
        this.socketManager = null;
    }
}
