import { MapDisplay } from '../MapDisplay';
import { modalManager } from '../../ModalManager';
import type { App } from '../../../core/App';
import type { NavaidSnapper } from '../navdata/NavaidSnapper';
import { BaseDrawingManager, DrawingPoint } from '../BaseDrawingManager';
import { lineStringFeature, pointFeature, polygonFeature, toLngLatCoords } from '../../../utils/geojson';
import { logger } from '../../../utils/Logger';
import {
    ensureGeoJSONSource,
    ensureLayer,
    safeRemoveLayer,
    safeRemoveSource,
    setLayerVisibility,
    updateSourceFeatures
} from '../../../utils/maplibre';
import { buildShapeCommand } from './shapeCommand';

/**
 * ShapeDrawingManager - Interactive polygon/polyline drawing on the map,
 * generating the POLY / POLYALT / POLYLINE command when the draw finishes.
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
     * Wire the name-modal's Create button and shape-type selector. Registered
     * with teardownSignal so App.cleanup() (which calls destroy()) removes
     * them - otherwise these long-lived listeners outlive the manager and
     * would drive a torn-down instance.
     */
    private setupModalHandlers(): void {
        const signal = this.teardownSignal;

        const createBtn = document.getElementById('create-polygon-btn');
        createBtn?.addEventListener('click', () => this.onCreatePolygonClick(), { signal });

        const shapeTypeSelect = document.getElementById('shape-type-select') as HTMLSelectElement | null;
        shapeTypeSelect?.addEventListener('change', () => this.updateShapeTypeUI(), { signal });
    }

    public toggleDrawing(): void {
        if (this.drawingMode) {
            this.stopDrawing();
        } else {
            this.showPolygonNameModal();
        }
    }

    private showPolygonNameModal(): void {
        const modal = modalManager.open('polygon-name-modal');
        if (modal) {
            const nameInput = document.getElementById('polygon-name-input') as HTMLInputElement;
            const topInput = document.getElementById('polygon-top-input') as HTMLInputElement;
            const bottomInput = document.getElementById('polygon-bottom-input') as HTMLInputElement;
            const shapeTypeSelect = document.getElementById('shape-type-select') as HTMLSelectElement;

            if (nameInput) nameInput.value = '';
            if (topInput) topInput.value = '';
            if (bottomInput) bottomInput.value = '';
            if (shapeTypeSelect) shapeTypeSelect.value = 'area';

            this.updateShapeTypeUI();

            setTimeout(() => {
                if (nameInput) nameInput.focus();
            }, 100);

            logger.debug('ShapeDrawingManager', 'Showing shape drawing modal');
        }
    }

    /** Sync the modal title and altitude-field visibility with the shape type. */
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

    /** Validate the modal inputs, then close it and start drawing. */
    private onCreatePolygonClick(): void {
        const nameInput = document.getElementById('polygon-name-input') as HTMLInputElement;
        const topInput = document.getElementById('polygon-top-input') as HTMLInputElement;
        const bottomInput = document.getElementById('polygon-bottom-input') as HTMLInputElement;
        const shapeTypeSelect = document.getElementById('shape-type-select') as HTMLSelectElement;

        const name = nameInput?.value.trim();
        const shapeType = shapeTypeSelect?.value || 'area';

        if (!name) {
            alert('Please enter a name for the shape');
            nameInput?.focus();
            return;
        }

        // Spaces and commas are BlueSky's argument separators - a name
        // containing them would corrupt the generated POLY/POLYLINE command.
        if (/[\s,]/.test(name)) {
            alert('Shape name cannot contain spaces or commas');
            nameInput?.focus();
            return;
        }

        this.currentShapeName = name;
        this.currentShapeType = shapeType as 'area' | 'line';

        // Altitudes only apply to areas; both filled makes a POLYALT.
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

        modalManager.close('polygon-name-modal');
        this.startDrawing();
    }

    private startDrawing(): void {
        this.drawingMode = true;
        this.drawingPoints = [];

        const drawBtn = document.getElementById('draw-shape-btn');
        if (drawBtn) {
            drawBtn.textContent = 'Stop Drawing';
            drawBtn.classList.add('active');
        }

        let bannerMessage = `Drawing "${this.currentShapeName}" - Click to add points, Right-click to finish, Esc to cancel`;
        if (this.topAltitude !== null && this.bottomAltitude !== null) {
            bannerMessage = `Drawing "${this.currentShapeName}" (${this.bottomAltitude}-${this.topAltitude}ft) - Click to add points, Right-click to finish, Esc to cancel`;
        }
        this.showDrawingBanner(bannerMessage);
        this.enableMapDrawing();

        logger.info('ShapeDrawingManager', `Started drawing ${this.currentShapeType}: ${this.currentShapeName}`);
    }

    private stopDrawing(): void {
        this.drawingMode = false;
        this.drawingPoints = [];
        this.currentShapeName = null;

        const drawBtn = document.getElementById('draw-shape-btn');
        if (drawBtn) {
            drawBtn.textContent = 'Draw Shape';
            drawBtn.classList.remove('active');
        }

        this.hideDrawingBanner();
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

    private getBannerMessage(): string {
        const pointCount = this.drawingPoints.length;
        let message = `Drawing "${this.currentShapeName}" - ${pointCount} point(s) (Right-click to finish, Esc to cancel)`;

        if (this.topAltitude !== null && this.bottomAltitude !== null) {
            message = `Drawing "${this.currentShapeName}" (${this.bottomAltitude}-${this.topAltitude}ft) - ${pointCount} point(s) (Right-click to finish, Esc to cancel)`;
        }

        return message;
    }

    /** Finish the draw: build the shape command and send it to BlueSky. */
    protected async finishDrawing(): Promise<void> {
        const minPoints = this.currentShapeType === 'line' ? 2 : 3;
        const shapeType = this.currentShapeType === 'line' ? 'line' : 'polygon';

        if (this.drawingPoints.length < minPoints) {
            alert(`Need at least ${minPoints} points to create a ${shapeType}`);
            return;
        }

        const command = this.generateCommand();
        logger.info('ShapeDrawingManager', `Generated command: ${command}`);

        // Leave drawing mode before the async send: a second right-click (or
        // Escape) while the send is in flight must not finish/cancel again.
        this.stopDrawing();

        // Send command to server via App, then echo it in the console.
        try {
            const success = await this.app.sendCommand(command);
            if (success) {
                logger.info('ShapeDrawingManager', `Shape command sent successfully: ${command}`);
                this.app.getConsole()?.displaySentCommand(command);
            } else {
                logger.error('ShapeDrawingManager', 'Failed to send shape command - success was false');
                alert('Failed to send shape command. Please check your connection.');
            }
        } catch (error) {
            logger.error('ShapeDrawingManager', 'Error sending shape command:', error);
            alert('Error sending shape command: ' + (error as Error).message);
        }
    }

    protected cancelDrawing(): void {
        logger.info('ShapeDrawingManager', `Drawing cancelled for "${this.currentShapeName}"`);
        this.stopDrawing();
    }

    /**
     * Generate the BlueSky command string for the current shape.
     */
    private generateCommand(): string {
        return buildShapeCommand({
            name: this.currentShapeName ?? '',
            type: this.currentShapeType,
            points: this.drawingPoints,
            topAltitude: this.topAltitude,
            bottomAltitude: this.bottomAltitude
        });
    }

    private setupTemporaryDrawingLayers(): void {
        const map = this.mapDisplay.getMap();
        if (!map) return;

        ensureGeoJSONSource(map, 'temp-drawing-points');
        ensureGeoJSONSource(map, 'temp-drawing-polygon');
        ensureGeoJSONSource(map, 'temp-drawing-preview');

        ensureLayer(map, {
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
        ensureLayer(map, {
            id: 'temp-drawing-polygon-line',
            source: 'temp-drawing-polygon',
            type: 'line',
            paint: {
                'line-color': '#ff6b00',
                'line-width': 2
            }
        });
        ensureLayer(map, {
            id: 'temp-drawing-polygon-fill',
            source: 'temp-drawing-polygon',
            type: 'fill',
            paint: {
                'fill-color': '#ff6b00',
                'fill-opacity': 0.1
            }
        });
        ensureLayer(map, {
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
        ensureLayer(map, {
            id: 'temp-drawing-preview-fill',
            source: 'temp-drawing-preview',
            type: 'fill',
            paint: {
                'fill-color': '#ffaa00',
                'fill-opacity': 0.05
            }
        });
    }

    private updateTemporaryDrawing(): void {
        const map = this.mapDisplay.getMap();
        if (!map) return;

        const pointFeatures = this.drawingPoints.map((point, index) =>
            pointFeature([point.lng, point.lat], { index }));
        updateSourceFeatures(map, 'temp-drawing-points', pointFeatures);

        const coordinates = toLngLatCoords(this.drawingPoints);
        const name = this.currentShapeName;

        if (this.currentShapeType === 'line') {
            // Lines: connect placed points directly, no fill.
            if (this.drawingPoints.length >= 2) {
                updateSourceFeatures(map, 'temp-drawing-polygon', [
                    lineStringFeature(coordinates, { name, 'drawing-type': 'line' })
                ]);
                setLayerVisibility(map, 'temp-drawing-polygon-fill', false);
            }
        } else if (this.drawingPoints.length >= 3) {
            // Areas: closed polygon with fill once there are 3+ points.
            updateSourceFeatures(map, 'temp-drawing-polygon', [
                polygonFeature(coordinates, { name, 'drawing-type': 'polygon' })
            ]);
            setLayerVisibility(map, 'temp-drawing-polygon-fill', true);
        } else if (this.drawingPoints.length === 2) {
            // Two points: show a line until the area can be closed.
            updateSourceFeatures(map, 'temp-drawing-polygon', [
                lineStringFeature(coordinates, { name, 'drawing-type': 'polygon-preview' })
            ]);
        }

        logger.debug('ShapeDrawingManager', `Drawing preview updated: ${this.drawingPoints.length} points`);
    }

    private updateCursorPreview(cursorPoint: { lat: number; lng: number }): void {
        const map = this.mapDisplay.getMap();
        if (!map) return;

        const features: GeoJSON.Feature[] = [];

        if (this.drawingPoints.length >= 1) {
            // Line from last placed point to the cursor.
            const lastPoint = this.drawingPoints[this.drawingPoints.length - 1];
            features.push(lineStringFeature(
                toLngLatCoords([lastPoint, cursorPoint]),
                { preview: 'next-line' }
            ));

            // For areas with 2+ points, also preview the closing line and fill.
            if (this.drawingPoints.length >= 2 && this.currentShapeType !== 'line') {
                const firstPoint = this.drawingPoints[0];
                features.push(lineStringFeature(
                    toLngLatCoords([cursorPoint, firstPoint]),
                    { preview: 'closing-line' }
                ));
                features.push(polygonFeature(
                    toLngLatCoords([...this.drawingPoints, cursorPoint]),
                    { preview: 'polygon-fill' }
                ));
            }
        }

        setLayerVisibility(map, 'temp-drawing-preview-fill', this.currentShapeType !== 'line');
        updateSourceFeatures(map, 'temp-drawing-preview', features);
    }

    private clearTemporaryDrawing(): void {
        const map = this.mapDisplay.getMap();
        if (!map) return;

        const sources = ['temp-drawing-points', 'temp-drawing-polygon', 'temp-drawing-preview'];
        sources.forEach(sourceId => updateSourceFeatures(map, sourceId, []));

        logger.debug('ShapeDrawingManager', 'Cleared temporary drawing visualization');
    }

    private removeTemporaryDrawingLayers(): void {
        const map = this.mapDisplay.getMap();
        if (!map) return;

        const layers = [
            'temp-drawing-points',
            'temp-drawing-polygon-line',
            'temp-drawing-polygon-fill',
            'temp-drawing-preview-line',
            'temp-drawing-preview-fill'
        ];

        layers.forEach(layerId => safeRemoveLayer(map, layerId));

        const sources = ['temp-drawing-points', 'temp-drawing-polygon', 'temp-drawing-preview'];
        sources.forEach(sourceId => safeRemoveSource(map, sourceId));

        logger.debug('ShapeDrawingManager', 'Removed temporary drawing layers');
    }
}
