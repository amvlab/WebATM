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
import { buildShapeCommand, ShapeType } from './shapeCommand';
import { boxCornerPoints, circleRingPoints, distanceNm } from './shapeGeometry';

/** Modal title per shape type. */
const SHAPE_TITLES: Record<ShapeType, string> = {
    area: 'Draw Area',
    line: 'Draw Line',
    circle: 'Draw Circle',
    box: 'Draw Box'
};

/** Word used in user-facing messages per shape type. */
const SHAPE_WORDS: Record<ShapeType, string> = {
    area: 'polygon',
    line: 'line',
    circle: 'circle',
    box: 'box'
};

/** First-click instruction shown in the banner when drawing starts. */
const START_INSTRUCTIONS: Record<ShapeType, string> = {
    area: 'Click to add points, Right-click to finish, Esc to cancel',
    line: 'Click to add points, Right-click to finish, Esc to cancel',
    circle: 'Click the centre, then click to set the radius, Esc to cancel',
    box: 'Click one corner, then the opposite corner, Esc to cancel'
};

/** Smallest accepted circle radius in nautical miles (~18 m). */
const MIN_CIRCLE_RADIUS_NM = 0.01;

/**
 * ShapeDrawingManager - Interactive shape drawing on the map, generating the
 * POLY / POLYALT / POLYLINE / BOX / CIRCLE command when the draw finishes.
 * Areas and lines are point-by-point (right-click finishes); boxes and
 * circles are two clicks (corner/opposite-corner, centre/radius) and finish
 * on the second click.
 */
export class ShapeDrawingManager extends BaseDrawingManager {
    private app: App;
    private currentShapeName: string | null = null;
    private currentShapeType: ShapeType = 'area';
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
        const shapeType = this.getSelectedShapeType();
        const modalTitle = document.getElementById('polygon-modal-title');
        const altitudeFields = document.getElementById('altitude-fields');

        if (modalTitle) modalTitle.textContent = SHAPE_TITLES[shapeType];
        // Areas, boxes and circles all support a vertical extent; lines don't.
        if (altitudeFields) altitudeFields.style.display = shapeType === 'line' ? 'none' : 'block';
    }

    /** Read the shape type from the modal's selector, defaulting to area. */
    private getSelectedShapeType(): ShapeType {
        const value = (document.getElementById('shape-type-select') as HTMLSelectElement | null)?.value;
        return value && value in SHAPE_TITLES ? value as ShapeType : 'area';
    }

    /** Validate the modal inputs, then close it and start drawing. */
    private onCreatePolygonClick(): void {
        const nameInput = document.getElementById('polygon-name-input') as HTMLInputElement;
        const topInput = document.getElementById('polygon-top-input') as HTMLInputElement;
        const bottomInput = document.getElementById('polygon-bottom-input') as HTMLInputElement;

        const name = nameInput?.value.trim();
        const shapeType = this.getSelectedShapeType();

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
        this.currentShapeType = shapeType;

        // Altitudes apply to everything but lines; on an area both filled
        // makes a POLYALT, on a box/circle they become the trailing
        // [top,bottom] arguments.
        if (shapeType !== 'line') {
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

        this.showDrawingBanner(
            `${this.getBannerPrefix()} - ${START_INSTRUCTIONS[this.currentShapeType]}`
        );
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

        logger.debug('ShapeDrawingManager', `Added point ${this.drawingPoints.length}: ${point.lat.toFixed(6)}, ${point.lng.toFixed(6)}`);

        // Boxes and circles are fully determined by two points - finish
        // immediately instead of waiting for a right-click.
        if (this.isTwoPointShape() && this.drawingPoints.length >= 2) {
            void this.finishDrawing();
            return;
        }

        this.showDrawingBanner(this.getBannerMessage());
        this.updateTemporaryDrawing();
    }

    /** Whether the current shape type finishes itself on the second click. */
    private isTwoPointShape(): boolean {
        return this.currentShapeType === 'box' || this.currentShapeType === 'circle';
    }

    /**
     * Handle mouse move - update cursor preview
     */
    protected onCursorMove(point: DrawingPoint): void {
        if (this.drawingPoints.length === 0) return;
        this.updateCursorPreview(point);
    }

    /** Shared banner lead-in: shape name plus vertical extent when set. */
    private getBannerPrefix(): string {
        const alts = this.topAltitude !== null && this.bottomAltitude !== null
            ? ` (${this.bottomAltitude}-${this.topAltitude}ft)`
            : '';
        return `Drawing "${this.currentShapeName}"${alts}`;
    }

    private getBannerMessage(liveRadiusNm?: number): string {
        switch (this.currentShapeType) {
            case 'box':
                return `${this.getBannerPrefix()} - Click the opposite corner (Esc to cancel)`;
            case 'circle': {
                const radius = liveRadiusNm !== undefined ? ` - radius ${liveRadiusNm.toFixed(2)} nm` : '';
                return `${this.getBannerPrefix()}${radius} - Click to set the radius (Esc to cancel)`;
            }
            default:
                return `${this.getBannerPrefix()} - ${this.drawingPoints.length} point(s) (Right-click to finish, Esc to cancel)`;
        }
    }

    /** Finish the draw: build the shape command and send it to BlueSky. */
    protected async finishDrawing(): Promise<void> {
        const minPoints = this.currentShapeType === 'area' ? 3 : 2;

        if (this.drawingPoints.length < minPoints) {
            alert(`Need at least ${minPoints} points to create a ${SHAPE_WORDS[this.currentShapeType]}`);
            return;
        }

        // A circle whose rim click landed on the centre has no radius; drop
        // the bad click and keep drawing instead of sending a degenerate
        // CIRCLE command.
        if (this.currentShapeType === 'circle'
            && distanceNm(this.drawingPoints[0], this.drawingPoints[1]) < MIN_CIRCLE_RADIUS_NM) {
            this.drawingPoints.pop();
            alert('Click a point away from the centre to set the circle radius');
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
            if (this.currentShapeType === 'box') {
                // Rectangle spanned by the first corner and the cursor.
                const ring = toLngLatCoords(boxCornerPoints(this.drawingPoints[0], cursorPoint));
                features.push(lineStringFeature([...ring, ring[0]], { preview: 'box-outline' }));
                features.push(polygonFeature(ring, { preview: 'polygon-fill' }));
            } else if (this.currentShapeType === 'circle') {
                // Circle around the centre with the cursor on its rim; keep
                // the live radius visible in the banner while aiming.
                const radiusNm = distanceNm(this.drawingPoints[0], cursorPoint);
                if (radiusNm >= MIN_CIRCLE_RADIUS_NM) {
                    const ring = toLngLatCoords(circleRingPoints(this.drawingPoints[0], radiusNm));
                    features.push(lineStringFeature([...ring, ring[0]], { preview: 'circle-outline' }));
                    features.push(polygonFeature(ring, { preview: 'polygon-fill' }));
                }
                this.showDrawingBanner(this.getBannerMessage(radiusNm));
            } else {
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
