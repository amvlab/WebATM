import { MapDisplay } from '../MapDisplay';
import { modalManager } from '../../ModalManager';
import { GeoJSONSource } from 'maplibre-gl';
import type { App } from '../../../core/App';
import type { NavaidSnapper } from '../navdata/NavaidSnapper';
import { BaseDrawingManager, DrawingPoint } from '../BaseDrawingManager';
import { featureCollection, lineStringFeature, pointFeature, polygonFeature, toLngLatCoords } from '../../../utils/geojson';
import { logger } from '../../../utils/Logger';
import { safeRemoveLayer, safeRemoveSource } from '../../../utils/maplibre';

/**
 * ShapeDrawingManager - Manages shape (polygon/polyline) drawing on the map
 *
 * Handles:
 * - Polygon and polyline drawing
 * - POLY, POLYALT, and POLYLINE command generation
 * - Interactive map clicking for shape definition
 * - Drawing state management
 */
export class ShapeDrawingManager extends BaseDrawingManager {
    private app: App;
    private currentShapeName: string | null = null;
    private currentShapeType: 'area' | 'line' = 'area';
    private drawingPoints: DrawingPoint[] = [];
    private topAltitude: number | null = null;
    private bottomAltitude: number | null = null;

    constructor(mapDisplay: MapDisplay, app: App, navaidSnapper: NavaidSnapper) {
        super(mapDisplay, navaidSnapper);
        this.app = app;
        this.setupModalHandlers();
    }

    /**
     * Set up modal event handlers
     */
    private setupModalHandlers(): void {
        // Handle Create Polygon button (Start Drawing)
        const createBtn = document.getElementById('create-polygon-btn');
        if (createBtn) {
            createBtn.addEventListener('click', () => {
                this.onCreatePolygonClick();
            });
        }

        // Handle shape type changes
        const shapeTypeSelect = document.getElementById('shape-type-select') as HTMLSelectElement;
        if (shapeTypeSelect) {
            shapeTypeSelect.addEventListener('change', () => {
                this.updateShapeTypeUI();
            });
        }
    }

    /**
     * Toggle drawing mode
     */
    public toggleDrawing(): void {
        if (this.drawingMode) {
            this.stopDrawing();
        } else {
            this.showPolygonNameModal();
        }
    }

    /**
     * Show the polygon/shape name modal
     */
    private showPolygonNameModal(): void {
        const modal = modalManager.open('polygon-name-modal');
        if (modal) {
            // Clear previous inputs
            const nameInput = document.getElementById('polygon-name-input') as HTMLInputElement;
            const topInput = document.getElementById('polygon-top-input') as HTMLInputElement;
            const bottomInput = document.getElementById('polygon-bottom-input') as HTMLInputElement;
            const shapeTypeSelect = document.getElementById('shape-type-select') as HTMLSelectElement;

            if (nameInput) nameInput.value = '';
            if (topInput) topInput.value = '';
            if (bottomInput) bottomInput.value = '';
            if (shapeTypeSelect) shapeTypeSelect.value = 'area';

            // Update UI based on shape type
            this.updateShapeTypeUI();

            // Focus on the name input
            setTimeout(() => {
                if (nameInput) nameInput.focus();
            }, 100);

            logger.debug('ShapeDrawingManager', 'Showing shape drawing modal');
        }
    }

    /**
     * Update UI based on shape type selection
     */
    private updateShapeTypeUI(): void {
        const shapeType = (document.getElementById('shape-type-select') as HTMLSelectElement)?.value || 'area';
        const modalTitle = document.getElementById('polygon-modal-title');
        const altitudeFields = document.getElementById('altitude-fields');

        if (shapeType === 'area') {
            if (modalTitle) modalTitle.textContent = 'Draw Area';
            if (altitudeFields) altitudeFields.style.display = 'block';
        } else {
            if (modalTitle) modalTitle.textContent = 'Draw Line';
            if (altitudeFields) altitudeFields.style.display = 'none';
        }
    }

    /**
     * Handle Create Polygon button click
     */
    private onCreatePolygonClick(): void {
        const nameInput = document.getElementById('polygon-name-input') as HTMLInputElement;
        const topInput = document.getElementById('polygon-top-input') as HTMLInputElement;
        const bottomInput = document.getElementById('polygon-bottom-input') as HTMLInputElement;
        const shapeTypeSelect = document.getElementById('shape-type-select') as HTMLSelectElement;

        const name = nameInput?.value.trim();
        const shapeType = shapeTypeSelect?.value || 'area';

        // Validate name
        if (!name) {
            alert('Please enter a name for the shape');
            nameInput?.focus();
            return;
        }

        // Check for spaces in name
        if (name.includes(' ')) {
            alert('Shape name cannot contain spaces');
            nameInput?.focus();
            return;
        }

        this.currentShapeName = name;
        this.currentShapeType = shapeType as 'area' | 'line';

        // Get altitude values if area
        if (shapeType === 'area') {
            const topValue = topInput?.value;
            const bottomValue = bottomInput?.value;

            if (topValue && bottomValue) {
                this.topAltitude = parseFloat(topValue);
                this.bottomAltitude = parseFloat(bottomValue);

                if (this.topAltitude <= this.bottomAltitude) {
                    alert('Top altitude must be greater than bottom altitude');
                    return;
                }
            } else {
                this.topAltitude = null;
                this.bottomAltitude = null;
            }
        } else {
            this.topAltitude = null;
            this.bottomAltitude = null;
        }

        // Close modal and start drawing
        modalManager.close('polygon-name-modal');
        this.startDrawing();
    }

    /**
     * Start drawing mode
     */
    private startDrawing(): void {
        this.drawingMode = true;
        this.drawingPoints = [];

        // Update UI - change button text
        const drawBtn = document.getElementById('draw-shape-btn');
        if (drawBtn) {
            drawBtn.textContent = 'Stop Drawing';
            drawBtn.classList.add('active');
        }

        // Show drawing banner
        let bannerMessage = `Drawing "${this.currentShapeName}" - Click to add points, Right-click to finish, Esc to cancel`;
        if (this.topAltitude !== null && this.bottomAltitude !== null) {
            bannerMessage = `Drawing "${this.currentShapeName}" (${this.bottomAltitude}-${this.topAltitude}ft) - Click to add points, Right-click to finish, Esc to cancel`;
        }
        this.showDrawingBanner(bannerMessage);

        // Enable map drawing handlers
        this.enableMapDrawing();

        logger.info('ShapeDrawingManager', `Started drawing ${this.currentShapeType}: ${this.currentShapeName}`);
    }

    /**
     * Stop drawing mode
     */
    private stopDrawing(): void {
        this.drawingMode = false;
        this.drawingPoints = [];
        this.currentShapeName = null;

        // Update UI - reset button
        const drawBtn = document.getElementById('draw-shape-btn');
        if (drawBtn) {
            drawBtn.textContent = 'Draw Shape';
            drawBtn.classList.remove('active');
        }

        // Hide drawing banner
        this.hideDrawingBanner();

        // Disable map drawing handlers
        this.disableMapDrawing();

        logger.info('ShapeDrawingManager', 'Stopped drawing');
    }

    /**
     * Set up temporary drawing layers when drawing starts.
     */
    protected onDrawingEnabled(): void {
        this.setupTemporaryDrawingLayers();
    }

    /**
     * Clear and remove temporary drawing layers when drawing stops.
     */
    protected onDrawingDisabled(): void {
        this.clearTemporaryDrawing();
        this.removeTemporaryDrawingLayers();
    }

    /**
     * Handle a placed point - update banner and preview.
     */
    protected onPointAdded(point: DrawingPoint): void {
        this.drawingPoints.push(point);

        this.showDrawingBanner(this.getBannerMessage());
        this.updateTemporaryDrawing();

        logger.debug('ShapeDrawingManager', `Added point ${this.drawingPoints.length}: ${point.lat.toFixed(6)}, ${point.lng.toFixed(6)}`);
    }

    /**
     * Handle mouse move - update cursor preview
     */
    protected onCursorMove(point: DrawingPoint): void {
        if (this.drawingPoints.length === 0) return;
        this.updateCursorPreview(point);
    }

    /**
     * Get banner message with current state
     */
    private getBannerMessage(): string {
        const pointCount = this.drawingPoints.length;
        let message = `Drawing "${this.currentShapeName}" - ${pointCount} point(s) (Right-click to finish, Esc to cancel)`;

        if (this.topAltitude !== null && this.bottomAltitude !== null) {
            message = `Drawing "${this.currentShapeName}" (${this.bottomAltitude}-${this.topAltitude}ft) - ${pointCount} point(s) (Right-click to finish, Esc to cancel)`;
        }

        return message;
    }

    /**
     * Finish drawing and generate command
     */
    protected async finishDrawing(): Promise<void> {
        const minPoints = this.currentShapeType === 'line' ? 2 : 3;
        const shapeType = this.currentShapeType === 'line' ? 'line' : 'polygon';

        if (this.drawingPoints.length < minPoints) {
            alert(`Need at least ${minPoints} points to create a ${shapeType}`);
            return;
        }

        // Generate command based on shape type
        const command = this.generateCommand();
        logger.info('ShapeDrawingManager', `Generated command: ${command}`);

        // Send command to server via App
        try {
            logger.debug('ShapeDrawingManager', 'About to send command via app.sendCommand');
            const success = await this.app.sendCommand(command);
            logger.debug('ShapeDrawingManager', 'sendCommand returned, success =', success);

            if (success) {
                logger.info('ShapeDrawingManager', `Shape command sent successfully: ${command}`);

                // Display the command in the console
                logger.debug('ShapeDrawingManager', 'Getting console instance from app');
                const consoleInstance = this.app.getConsole();
                logger.debug('ShapeDrawingManager', 'Console instance:', consoleInstance);

                if (consoleInstance) {
                    logger.debug('ShapeDrawingManager', 'Calling displaySentCommand with:', command);
                    consoleInstance.displaySentCommand(command);
                } else {
                    logger.warn('ShapeDrawingManager', 'Console instance is null');
                }
            } else {
                logger.error('ShapeDrawingManager', '🖊️ Failed to send shape command - success was false');
                alert('Failed to send shape command. Please check your connection.');
            }
        } catch (error) {
            logger.error('ShapeDrawingManager', '🖊️ Error sending shape command:', error);
            alert('Error sending shape command: ' + (error as Error).message);
        }

        logger.debug('ShapeDrawingManager', 'After try-catch block');

        // Stop drawing
        this.stopDrawing();
    }

    /**
     * Cancel drawing without generating command
     */
    protected cancelDrawing(): void {
        logger.info('ShapeDrawingManager', `Drawing cancelled for "${this.currentShapeName}"`);
        this.stopDrawing();
    }

    /**
     * Generate command string based on shape type and points
     */
    private generateCommand(): string {
        // Convert points to coordinate string
        const coords = this.drawingPoints.flatMap(p => [p.lat.toFixed(6), p.lng.toFixed(6)]);

        if (this.currentShapeType === 'line') {
            // POLYLINE format: POLYLINE name,lat,lon,lat,lon,...
            return `POLYLINE ${this.currentShapeName},${coords.join(',')}`;
        } else if (this.topAltitude !== null && this.bottomAltitude !== null) {
            // POLYALT format: POLYALT name,top,bottom,lat,lon,lat,lon,...
            return `POLYALT ${this.currentShapeName},${this.topAltitude},${this.bottomAltitude},${coords.join(',')}`;
        } else {
            // POLY format: POLY name,lat,lon,lat,lon,...
            return `POLY ${this.currentShapeName},${coords.join(',')}`;
        }
    }

    /**
     * Setup temporary drawing layers for visualization
     */
    private setupTemporaryDrawingLayers(): void {
        const map = this.mapDisplay.getMap();
        if (!map) return;

        // Add sources if they don't exist
        const sourceIds = ['temp-drawing-points', 'temp-drawing-polygon', 'temp-drawing-preview'];
        for (const sourceId of sourceIds) {
            if (!map.getSource(sourceId)) {
                map.addSource(sourceId, { type: 'geojson', data: featureCollection() });
            }
        }

        // Add layers for points
        if (!map.getLayer('temp-drawing-points')) {
            map.addLayer({
                id: 'temp-drawing-points',
                source: 'temp-drawing-points',
                type: 'circle',
                paint: {
                    'circle-radius': 6,
                    'circle-color': '#ff6b00',
                    'circle-stroke-width': 2,
                    'circle-stroke-color': '#ffffff'
                }
            });
        }

        // Add layers for polygon/line
        if (!map.getLayer('temp-drawing-polygon-line')) {
            map.addLayer({
                id: 'temp-drawing-polygon-line',
                source: 'temp-drawing-polygon',
                type: 'line',
                paint: {
                    'line-color': '#ff6b00',
                    'line-width': 2
                }
            });
        }

        if (!map.getLayer('temp-drawing-polygon-fill')) {
            map.addLayer({
                id: 'temp-drawing-polygon-fill',
                source: 'temp-drawing-polygon',
                type: 'fill',
                paint: {
                    'fill-color': '#ff6b00',
                    'fill-opacity': 0.1
                }
            });
        }

        // Add layers for cursor preview
        if (!map.getLayer('temp-drawing-preview-line')) {
            map.addLayer({
                id: 'temp-drawing-preview-line',
                source: 'temp-drawing-preview',
                type: 'line',
                paint: {
                    'line-color': '#ffaa00',
                    'line-width': 1,
                    'line-dasharray': [4, 4],
                    'line-opacity': 0.8
                }
            });
        }

        if (!map.getLayer('temp-drawing-preview-fill')) {
            map.addLayer({
                id: 'temp-drawing-preview-fill',
                source: 'temp-drawing-preview',
                type: 'fill',
                paint: {
                    'fill-color': '#ffaa00',
                    'fill-opacity': 0.05
                }
            });
        }
    }

    /**
     * Update temporary drawing visualization
     */
    private updateTemporaryDrawing(): void {
        const map = this.mapDisplay.getMap();
        if (!map) return;

        // Update point markers
        const pointFeatures = this.drawingPoints.map((point, index) =>
            pointFeature([point.lng, point.lat], { index }));

        const pointSource = map.getSource('temp-drawing-points') as GeoJSONSource;
        if (pointSource) {
            pointSource.setData(featureCollection(pointFeatures));
        }

        const coordinates = toLngLatCoords(this.drawingPoints);
        const polygonSource = map.getSource('temp-drawing-polygon') as GeoJSONSource;

        // Update polygon/line visualization
        if (this.currentShapeType === 'line') {
            // For lines, show simple line connections between points
            if (this.drawingPoints.length >= 2) {
                if (polygonSource) {
                    polygonSource.setData(featureCollection([
                        lineStringFeature(coordinates, {
                            name: this.currentShapeName,
                            'drawing-type': 'line'
                        })
                    ]));
                }

                // Hide fill layer for lines
                map.setLayoutProperty('temp-drawing-polygon-fill', 'visibility', 'none');
            }
        } else {
            // For areas/polygons
            if (this.drawingPoints.length >= 3) {
                if (polygonSource) {
                    polygonSource.setData(featureCollection([
                        polygonFeature(coordinates, {
                            name: this.currentShapeName,
                            'drawing-type': 'polygon'
                        })
                    ]));
                }

                // Show fill layer for polygons
                map.setLayoutProperty('temp-drawing-polygon-fill', 'visibility', 'visible');
            } else if (this.drawingPoints.length === 2) {
                // Show line preview
                if (polygonSource) {
                    polygonSource.setData(featureCollection([
                        lineStringFeature(coordinates, {
                            name: this.currentShapeName,
                            'drawing-type': 'polygon-preview'
                        })
                    ]));
                }
            }
        }

        logger.debug('ShapeDrawingManager', `Drawing preview updated: ${this.drawingPoints.length} points`);
    }

    /**
     * Update cursor preview
     */
    private updateCursorPreview(cursorPoint: {lat: number, lng: number}): void {
        const map = this.mapDisplay.getMap();
        if (!map) return;

        const features: GeoJSON.Feature[] = [];

        if (this.drawingPoints.length >= 1) {
            // Line from last point to cursor
            const lastPoint = this.drawingPoints[this.drawingPoints.length - 1];
            features.push(lineStringFeature(
                toLngLatCoords([lastPoint, cursorPoint]),
                { preview: 'next-line' }
            ));

            // For polygons with 2+ points, show closing line and fill preview
            if (this.drawingPoints.length >= 2 && this.currentShapeType !== 'line') {
                const firstPoint = this.drawingPoints[0];

                // Closing line from cursor to first point
                features.push(lineStringFeature(
                    toLngLatCoords([cursorPoint, firstPoint]),
                    { preview: 'closing-line' }
                ));

                // Polygon preview with fill (ring closed by polygonFeature)
                features.push(polygonFeature(
                    toLngLatCoords([...this.drawingPoints, cursorPoint]),
                    { preview: 'polygon-fill' }
                ));
            }
        }

        // Update visibility for preview fill layer
        if (this.currentShapeType === 'line') {
            map.setLayoutProperty('temp-drawing-preview-fill', 'visibility', 'none');
        } else {
            map.setLayoutProperty('temp-drawing-preview-fill', 'visibility', 'visible');
        }

        // Update preview source
        const previewSource = map.getSource('temp-drawing-preview') as GeoJSONSource;
        if (previewSource) {
            previewSource.setData(featureCollection(features));
        }
    }

    /**
     * Clear temporary drawing visualization
     */
    private clearTemporaryDrawing(): void {
        const map = this.mapDisplay.getMap();
        if (!map) return;

        // Clear all temporary drawing data
        const sources = ['temp-drawing-points', 'temp-drawing-polygon', 'temp-drawing-preview'];
        sources.forEach(sourceId => {
            const source = map.getSource(sourceId) as GeoJSONSource;
            if (source) {
                source.setData(featureCollection());
            }
        });

        logger.debug('ShapeDrawingManager', 'Cleared temporary drawing visualization');
    }

    /**
     * Remove temporary drawing layers
     */
    private removeTemporaryDrawingLayers(): void {
        const map = this.mapDisplay.getMap();
        if (!map) return;

        // Remove layers
        const layers = [
            'temp-drawing-points',
            'temp-drawing-polygon-line',
            'temp-drawing-polygon-fill',
            'temp-drawing-preview-line',
            'temp-drawing-preview-fill'
        ];

        layers.forEach(layerId => safeRemoveLayer(map, layerId));

        // Remove sources
        const sources = ['temp-drawing-points', 'temp-drawing-polygon', 'temp-drawing-preview'];
        sources.forEach(sourceId => safeRemoveSource(map, sourceId));

        logger.debug('ShapeDrawingManager', 'Removed temporary drawing layers');
    }
}
