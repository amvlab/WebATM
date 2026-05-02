import * as THREE from 'three';
import { MercatorCoordinate } from 'maplibre-gl';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { CustomLayer3D } from '../rendering/CustomLayer3D';
import type { RouteData, DisplayOptions } from '../../../data/types';
import { logger } from '../../../utils/Logger';

/**
 * 3D aircraft route renderer using Three.js.
 *
 * Renders the selected aircraft's route as elevated line segments and
 * waypoint spheres in the 3D scene so the route visually aligns with the
 * 3D aircraft's altitude.
 *
 * Altitude rule per segment endpoint:
 *   - If `wpalt[i] > 0`: use that constraint altitude (meters)
 *   - Otherwise: use the aircraft's current altitude
 *
 * NOTE: v1 uses scene-relative mercator positioning only. Globe-projection
 * support is a known follow-up (would need per-vertex getMatrixForModel).
 */
export class AircraftRoute3DRenderer {
    private customLayer: AircraftRoute3DCustomLayer;
    private map: MapLibreMap | null = null;
    private displayOptions: DisplayOptions;

    constructor(displayOptions: DisplayOptions) {
        this.displayOptions = displayOptions;
        this.customLayer = new AircraftRoute3DCustomLayer(displayOptions);
    }

    initialize(map: MapLibreMap): void {
        this.map = map;

        if (map.getLayer(this.customLayer.id)) {
            logger.warn('AircraftRoute3DRenderer', `Layer ${this.customLayer.id} already exists, removing first`);
            map.removeLayer(this.customLayer.id);
        }

        if (map.isStyleLoaded()) {
            this.addLayerToMap(map);
        } else {
            const waitForStyle = () => {
                if (map.isStyleLoaded()) {
                    this.addLayerToMap(map);
                } else {
                    requestAnimationFrame(waitForStyle);
                }
            };
            requestAnimationFrame(waitForStyle);
        }
    }

    private addLayerToMap(map: MapLibreMap): void {
        try {
            if (map.getLayer(this.customLayer.id)) {
                map.removeLayer(this.customLayer.id);
            }
            map.addLayer(this.customLayer as any);
            logger.debug('AircraftRoute3DRenderer', '3D route layer added to map');
        } catch (error) {
            logger.error('AircraftRoute3DRenderer', `Failed to add 3D route layer: ${error}`);
        }
    }

    updateRouteData(data: RouteData | null): void {
        this.customLayer.setRouteData(data);
    }

    setSelectedAircraft(aircraftId: string | null): void {
        this.customLayer.setSelectedAircraft(aircraftId);
    }

    setAircraftState(lat: number, lon: number, alt: number): void {
        this.customLayer.setAircraftState(lat, lon, alt);
    }

    updateDisplayOptions(options: DisplayOptions): void {
        this.displayOptions = options;
        this.customLayer.updateDisplayOptions(options);
    }

    onStyleChange(): void {
        if (!this.map) return;

        const reinitializeLayer = () => {
            if (!this.map) return;
            try {
                if (this.map.getLayer(this.customLayer.id)) {
                    this.map.removeLayer(this.customLayer.id);
                }
                const previousState = this.customLayer.exportState();
                this.customLayer.cleanup();
                this.customLayer = new AircraftRoute3DCustomLayer(this.displayOptions);
                this.customLayer.importState(previousState);
                this.addLayerToMap(this.map);
            } catch (error) {
                logger.error('AircraftRoute3DRenderer', `Failed to reinitialize 3D route layer: ${error}`);
            }
        };

        if (this.map.isStyleLoaded()) {
            requestAnimationFrame(reinitializeLayer);
        } else {
            const waitAndReinitialize = () => {
                if (this.map && this.map.isStyleLoaded()) {
                    reinitializeLayer();
                } else if (this.map) {
                    requestAnimationFrame(waitAndReinitialize);
                }
            };
            requestAnimationFrame(waitAndReinitialize);
        }
    }

    destroy(): void {
        try {
            if (this.map && this.map.getLayer(this.customLayer.id)) {
                this.map.removeLayer(this.customLayer.id);
            }
        } catch (error) {
            logger.error('AircraftRoute3DRenderer', `Error removing 3D route layer: ${error}`);
        }

        try {
            this.customLayer.cleanup();
        } catch (error) {
            logger.error('AircraftRoute3DRenderer', `Error cleaning up custom layer: ${error}`);
        }

        this.map = null;
    }
}

interface RouteLayerState {
    routeData: RouteData | null;
    selectedAircraftId: string | null;
    aircraftState: { lat: number; lon: number; alt: number } | null;
}

const PASSED_COLOR = 0x888888;
const ACTIVE_WAYPOINT_COLOR = 0x00ff00;
const DEFAULT_LINE_WIDTH = 2;

class AircraftRoute3DCustomLayer extends CustomLayer3D {
    private displayOptions: DisplayOptions;
    private routeData: RouteData | null = null;
    private selectedAircraftId: string | null = null;
    private aircraftState: { lat: number; lon: number; alt: number } | null = null;
    private sphereMeshes: THREE.Mesh[] = [];
    private lineObjects: THREE.Line[] = [];
    private sceneOrigin: { lng: number; lat: number } | null = null;
    private sceneOriginElevation: number = 0;

    // Scene-relative mercator group. Matches Aircraft3DCustomLayer's mercator group
    // conventions (x=east, y=up, z=north) so geometry aligns with aircraft meshes.
    private mercatorGroup: THREE.Group | null = null;

    constructor(displayOptions: DisplayOptions) {
        super('route-3d-layer');
        this.displayOptions = displayOptions;
    }

    protected onSceneReady(): void {
        this.mercatorGroup = new THREE.Group();
        this.mercatorGroup.rotateX(Math.PI / 2);
        this.mercatorGroup.scale.multiply(new THREE.Vector3(1, 1, -1));
        this.scene.add(this.mercatorGroup);

        this.rebuildScene();
    }

    setRouteData(data: RouteData | null): void {
        this.routeData = data;
        this.rebuildScene();
    }

    setSelectedAircraft(aircraftId: string | null): void {
        this.selectedAircraftId = aircraftId;
        this.rebuildScene();
    }

    setAircraftState(lat: number, lon: number, alt: number): void {
        this.aircraftState = { lat, lon, alt };
        this.rebuildScene();
    }

    updateDisplayOptions(options: DisplayOptions): void {
        this.displayOptions = options;
        this.rebuildScene();
    }

    exportState(): RouteLayerState {
        return {
            routeData: this.routeData,
            selectedAircraftId: this.selectedAircraftId,
            aircraftState: this.aircraftState
        };
    }

    importState(state: RouteLayerState): void {
        this.routeData = state.routeData;
        this.selectedAircraftId = state.selectedAircraftId;
        this.aircraftState = state.aircraftState;
    }

    cleanup(): void {
        this.clearGeometry();
    }

    private clearGeometry(): void {
        if (!this.mercatorGroup) return;

        for (const sphere of this.sphereMeshes) {
            this.mercatorGroup.remove(sphere);
            sphere.geometry.dispose();
            if (sphere.material instanceof THREE.Material) {
                sphere.material.dispose();
            }
        }
        this.sphereMeshes = [];

        for (const line of this.lineObjects) {
            this.mercatorGroup.remove(line);
            line.geometry.dispose();
            if (line.material instanceof THREE.Material) {
                line.material.dispose();
            }
        }
        this.lineObjects = [];
    }

    private rebuildScene(): void {
        if (!this.scene || !this.mercatorGroup) {
            return;
        }

        this.clearGeometry();

        if (!this.shouldRender()) {
            return;
        }

        const data = this.routeData!;
        const aircraft = this.aircraftState!;
        this.updateSceneOrigin();

        const iactwp = Math.max(0, Math.min(data.iactwp || 0, data.wplat.length - 1));

        const altFor = (i: number): number => {
            const wpalt = data.wpalt && data.wpalt[i] !== undefined ? data.wpalt[i] : -1;
            return wpalt > 0 ? wpalt : aircraft.alt;
        };

        const aircraftPos = this.toScenePos(aircraft.lat, aircraft.lon, aircraft.alt);

        const waypointPositions: THREE.Vector3[] = [];
        for (let i = 0; i < data.wplat.length; i++) {
            waypointPositions.push(this.toScenePos(data.wplat[i], data.wplon[i], altFor(i)));
        }

        const showLines = this.displayOptions.showRoutes && this.displayOptions.showRouteLines;
        const showPoints = this.displayOptions.showRoutes && this.displayOptions.showRoutePoints;

        if (showLines) {
            this.buildLines(aircraftPos, waypointPositions, iactwp);
        }

        if (showPoints) {
            this.buildSpheres(waypointPositions, iactwp);
        }

        this.map.triggerRepaint();
    }

    private shouldRender(): boolean {
        if (!this.displayOptions.showRoutes) return false;
        if (!this.routeData || !this.routeData.acid) return false;
        if (!this.selectedAircraftId) return false;
        if (this.routeData.acid !== this.selectedAircraftId) return false;
        if (!this.aircraftState) return false;
        if (!this.routeData.wplat || this.routeData.wplat.length === 0) return false;
        if (this.routeData.wplon?.length !== this.routeData.wplat.length) return false;
        return true;
    }

    private buildLines(
        aircraftPos: THREE.Vector3,
        waypointPositions: THREE.Vector3[],
        iactwp: number
    ): void {
        if (!this.mercatorGroup) return;

        const activeColor = this.parseColor(this.displayOptions.routeLinesColor, 0x00aaff);

        // Aircraft -> active waypoint (solid, active color)
        if (waypointPositions[iactwp]) {
            this.lineObjects.push(
                this.makeLine([aircraftPos, waypointPositions[iactwp]], activeColor)
            );
        }

        // Passed segments: waypoint[i] -> waypoint[i+1] for i < iactwp (grey)
        for (let i = 0; i < iactwp; i++) {
            const a = waypointPositions[i];
            const b = waypointPositions[i + 1];
            if (a && b) {
                this.lineObjects.push(this.makeLine([a, b], PASSED_COLOR));
            }
        }

        // Upcoming segments: waypoint[i] -> waypoint[i+1] for i >= iactwp (active color)
        for (let i = iactwp; i < waypointPositions.length - 1; i++) {
            const a = waypointPositions[i];
            const b = waypointPositions[i + 1];
            if (a && b) {
                this.lineObjects.push(this.makeLine([a, b], activeColor));
            }
        }
    }

    private buildSpheres(waypointPositions: THREE.Vector3[], iactwp: number): void {
        if (!this.mercatorGroup) return;

        const baseRadius = 60 * (this.displayOptions.aircraft3DScale || 2.0);
        const upcomingColor = this.parseColor(this.displayOptions.routePointsColor, 0x00aaff);

        for (let i = 0; i < waypointPositions.length; i++) {
            const isActive = i === iactwp;
            const isPassed = i < iactwp;

            const radius = isActive ? baseRadius * 1.5 : baseRadius;
            const color = isActive
                ? ACTIVE_WAYPOINT_COLOR
                : isPassed
                    ? PASSED_COLOR
                    : upcomingColor;

            const geometry = new THREE.SphereGeometry(radius, 16, 12);
            const material = new THREE.MeshBasicMaterial({ color });
            const mesh = new THREE.Mesh(geometry, material);
            mesh.position.copy(waypointPositions[i]);
            mesh.frustumCulled = false;

            this.mercatorGroup.add(mesh);
            this.sphereMeshes.push(mesh);
        }
    }

    private makeLine(points: THREE.Vector3[], color: number): THREE.Line {
        const geometry = new THREE.BufferGeometry().setFromPoints(points);
        const material = new THREE.LineBasicMaterial({
            color,
            linewidth: DEFAULT_LINE_WIDTH
        });
        const line = new THREE.Line(geometry, material);
        line.frustumCulled = false;
        this.mercatorGroup!.add(line);
        return line;
    }

    private parseColor(css: string | undefined, fallback: number): number {
        if (!css) return fallback;
        try {
            return new THREE.Color(css).getHex();
        } catch {
            return fallback;
        }
    }

    /**
     * Convert lat/lon/alt to scene-relative meter coordinates for the mercator group.
     * Scene axes after group rotation: x=east, y=up, z=north. Altitude in meters.
     */
    private toScenePos(lat: number, lon: number, altitudeMeters: number): THREE.Vector3 {
        const rel = this.calculateRelativePosition(lat, lon);
        return new THREE.Vector3(rel.east, altitudeMeters, rel.north);
    }

    private calculateRelativePosition(lat: number, lng: number): { east: number; north: number } {
        if (!this.sceneOrigin) {
            return { east: 0, north: 0 };
        }

        const originMercator = MercatorCoordinate.fromLngLat([this.sceneOrigin.lng, this.sceneOrigin.lat]);
        const targetMercator = MercatorCoordinate.fromLngLat([lng, lat]);

        const mercatorPerMeter = originMercator.meterInMercatorCoordinateUnits();
        const dEast = (targetMercator.x - originMercator.x) / mercatorPerMeter;
        const dNorth = (originMercator.y - targetMercator.y) / mercatorPerMeter;

        return { east: dEast, north: dNorth };
    }

    /**
     * Scene origin tracks the current aircraft position when available,
     * so the route geometry stays close to the origin and matches the
     * aircraft 3D layer's relative-positioning scheme.
     */
    private updateSceneOrigin(): void {
        if (this.aircraftState) {
            this.sceneOrigin = {
                lng: this.aircraftState.lon,
                lat: this.aircraftState.lat
            };
        } else if (!this.sceneOrigin && this.map) {
            const center = this.map.getCenter();
            this.sceneOrigin = { lng: center.lng, lat: center.lat };
        }
    }

    protected updateScene(args?: any): void {
        if (!this.sceneOrigin || !args || !this.mercatorGroup) return;

        const sceneOriginMercator = MercatorCoordinate.fromLngLat(
            [this.sceneOrigin.lng, this.sceneOrigin.lat],
            this.sceneOriginElevation
        );

        const m = new THREE.Matrix4().fromArray(args.defaultProjectionData.mainMatrix);
        const l = new THREE.Matrix4()
            .makeTranslation(sceneOriginMercator.x, sceneOriginMercator.y, sceneOriginMercator.z)
            .scale(new THREE.Vector3(
                sceneOriginMercator.meterInMercatorCoordinateUnits(),
                -sceneOriginMercator.meterInMercatorCoordinateUnits(),
                sceneOriginMercator.meterInMercatorCoordinateUnits()
            ));

        this.camera.projectionMatrix = m.multiply(l);
    }
}
