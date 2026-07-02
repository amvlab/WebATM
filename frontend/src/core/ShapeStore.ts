import { Shape, PolygonShape, PolylineShape, PolyData, PolylineData } from '../data/types';
import { logger } from '../utils/Logger';

export type ShapeChangeListener = (shapes: Map<string, Shape>) => void;

/**
 * Convert server PolyData ({name, lat[], lon[], color?, fill?}) to a client
 * PolygonShape ({type, name, coordinates: {lat, lng}[], ...styling}).
 */
export function polyDataToShape(data: PolyData, nodeId?: string): PolygonShape {
    if (!data.lat || !data.lon || !Array.isArray(data.lat) || !Array.isArray(data.lon)) {
        logger.warn('ShapeStore', 'Invalid PolyData received - missing or invalid lat/lon arrays:', data);
        // Minimal valid shape with empty coordinates so callers never crash.
        return {
            type: 'polygon',
            name: data.name || 'unnamed',
            visible: true,
            nodeId,
            coordinates: [],
            fillColor: data.color,
            fillOpacity: 0.2,
            strokeColor: data.color,
            strokeWidth: 2
        };
    }

    const coordinates = data.lat.map((lat, i) => ({
        lat,
        lng: data.lon[i]
    }));

    return {
        type: 'polygon',
        name: data.name,
        visible: true,
        nodeId,
        coordinates,
        topAltitude: data.top,
        bottomAltitude: data.bottom,
        fillColor: data.color,
        fillOpacity: 0.2,  // Always set visible opacity - display toggle controls visibility
        strokeColor: data.color,
        strokeWidth: 2
    };
}

/**
 * Convert server PolylineData ({name, lat[], lon[], color?, width?}) to a
 * client PolylineShape ({type, name, coordinates: {lat, lng}[], ...styling}).
 */
export function polylineDataToShape(data: PolylineData, nodeId?: string): PolylineShape {
    if (!data.lat || !data.lon || !Array.isArray(data.lat) || !Array.isArray(data.lon)) {
        logger.warn('ShapeStore', 'Invalid PolylineData received - missing or invalid lat/lon arrays:', data);
        // Minimal valid shape with empty coordinates so callers never crash.
        return {
            type: 'polyline',
            name: data.name || 'unnamed',
            visible: true,
            nodeId,
            coordinates: [],
            color: data.color,
            width: data.width || 2
        };
    }

    const coordinates = data.lat.map((lat, i) => ({
        lat,
        lng: data.lon[i]
    }));

    return {
        type: 'polyline',
        name: data.name,
        visible: true,
        nodeId,
        coordinates,
        color: data.color,
        width: data.width || 2
    };
}

/**
 * ShapeStore - name-indexed storage for simulation shapes (polygons,
 * polylines) with change notification. The StateManager facade delegates
 * here. Shapes belong to the simulation, so they are cleared on node
 * switches and resets rather than persisted like user preferences.
 */
export class ShapeStore {
    private shapes: Map<string, Shape> = new Map();
    private listeners: Set<ShapeChangeListener> = new Set();

    /**
     * Subscribe to shape changes
     * Returns unsubscribe function
     */
    subscribe(listener: ShapeChangeListener): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    /**
     * Notify all shape listeners of changes
     */
    notifyListeners(): void {
        const shapesCopy = new Map(this.shapes);
        this.listeners.forEach(listener => {
            try {
                listener(shapesCopy);
            } catch (error) {
                logger.error('ShapeStore', 'Error in shape change listener:', error);
            }
        });
    }

    /**
     * Add or update a shape
     * @param notify - If false, don't notify listeners (for batch updates)
     */
    add(shape: Shape, notify: boolean = true): void {
        const isUpdate = this.shapes.has(shape.name);
        logger.debug('ShapeStore', `${isUpdate ? 'Updating' : 'Adding'} shape: ${shape.name} (type: ${shape.type})`);
        this.shapes.set(shape.name, shape);
        if (notify) {
            this.notifyListeners();
        }
    }

    /**
     * Add multiple shapes in a batch (only notifies once)
     */
    addBatch(shapes: Shape[]): void {
        logger.debug('ShapeStore', `Adding ${shapes.length} shapes in batch`);
        shapes.forEach(shape => this.add(shape, false));
        this.notifyListeners();
    }

    /**
     * Add or update shape from server PolyData format
     */
    addPolyData(data: PolyData, nodeId?: string): void {
        if (!data.lat || !data.lon || !Array.isArray(data.lat) || !Array.isArray(data.lon)) {
            logger.warn('ShapeStore', 'Skipping PolyData - missing or invalid lat/lon arrays');
            return;
        }
        if (data.lat.length === 0 || data.lon.length === 0) {
            logger.warn('ShapeStore', 'Skipping PolyData - empty lat/lon arrays');
            return;
        }

        this.add(polyDataToShape(data, nodeId));
    }

    /**
     * Add or update shape from server PolylineData format
     */
    addPolylineData(data: PolylineData, nodeId?: string): void {
        if (!data.lat || !data.lon || !Array.isArray(data.lat) || !Array.isArray(data.lon)) {
            logger.warn('ShapeStore', 'Skipping PolylineData - missing or invalid lat/lon arrays');
            return;
        }
        if (data.lat.length === 0 || data.lon.length === 0) {
            logger.warn('ShapeStore', 'Skipping PolylineData - empty lat/lon arrays');
            return;
        }

        this.add(polylineDataToShape(data, nodeId));
    }

    /**
     * Delete a shape by name
     */
    delete(name: string): boolean {
        logger.debug('ShapeStore', `Deleting shape: ${name}`);
        const deleted = this.shapes.delete(name);
        if (deleted) {
            this.notifyListeners();
        }
        return deleted;
    }

    /**
     * Get a shape by name
     */
    get(name: string): Shape | undefined {
        return this.shapes.get(name);
    }

    /**
     * Get all shapes
     */
    getAll(): Map<string, Shape> {
        return new Map(this.shapes);
    }

    /**
     * Get shapes by type
     */
    getByType<T extends Shape['type']>(type: T): Shape[] {
        return Array.from(this.shapes.values()).filter(
            (shape): shape is Extract<Shape, { type: T }> => shape.type === type
        );
    }

    /**
     * Get shapes for a specific node
     */
    getByNode(nodeId: string): Shape[] {
        return Array.from(this.shapes.values()).filter(
            shape => shape.nodeId === nodeId
        );
    }

    /**
     * Clear all shapes
     * Called when switching nodes or resetting simulation
     */
    clear(): void {
        logger.debug('ShapeStore', 'Clearing all shapes');
        this.shapes.clear();
        this.notifyListeners();
    }

    /**
     * Clear shapes for a specific node
     */
    clearForNode(nodeId: string): void {
        logger.debug('ShapeStore', `Clearing shapes for node: ${nodeId}`);
        let changed = false;

        // Delete all shapes for this node
        for (const [name, shape] of this.shapes.entries()) {
            if (shape.nodeId === nodeId) {
                this.shapes.delete(name);
                changed = true;
            }
        }

        if (changed) {
            this.notifyListeners();
        }
    }

    /**
     * Update shape visibility
     */
    setVisibility(name: string, visible: boolean): void {
        const shape = this.shapes.get(name);
        if (shape && shape.visible !== visible) {
            shape.visible = visible;
            this.notifyListeners();
        }
    }

    /**
     * Get shape count
     */
    get size(): number {
        return this.shapes.size;
    }
}
