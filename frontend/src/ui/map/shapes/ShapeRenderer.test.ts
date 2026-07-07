/**
 * Regression tests for ShapeRenderer's subscription lifecycle: it must
 * subscribe to shape/display-option changes exactly once for its lifetime.
 * The old code re-subscribed inside initialize(), which re-runs on every map
 * style change and source recovery, so each style switch stacked another
 * listener and multiplied the render work per shape update; destroy() also
 * never unsubscribed, leaving a torn-down renderer driven forever.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ShapeRenderer } from './ShapeRenderer';
import { StateManager } from '../../../core/StateManager';
import type { MapDisplay } from '../MapDisplay';
import type { PolygonShape } from '../../../data/types';

interface FakeSource {
    setData: ReturnType<typeof vi.fn>;
}

/** Minimal MapLibre map double covering what ShapeRenderer touches. */
class FakeMap {
    public sources = new Map<string, FakeSource>();
    private layers = new Set<string>();

    getSource(id: string): FakeSource | undefined {
        return this.sources.get(id);
    }
    addSource(id: string): void {
        this.sources.set(id, { setData: vi.fn() });
    }
    removeSource(id: string): void {
        this.sources.delete(id);
    }
    getLayer(id: string): { id: string } | undefined {
        return this.layers.has(id) ? { id } : undefined;
    }
    addLayer(spec: { id: string }): void {
        this.layers.add(spec.id);
    }
    removeLayer(id: string): void {
        this.layers.delete(id);
    }
    once(): void {}
    setPaintProperty(): void {}
    setLayoutProperty(): void {}

    /** Simulate a style change wiping all styles' sources and layers. */
    wipeStyle(): void {
        this.sources.clear();
        this.layers.clear();
    }
}

function makePolygon(name: string): PolygonShape {
    return {
        type: 'polygon',
        name,
        visible: true,
        coordinates: [
            { lat: 52, lng: 4 },
            { lat: 53, lng: 5 },
            { lat: 52.5, lng: 6 }
        ]
    };
}

describe('ShapeRenderer subscription lifecycle', () => {
    let fakeMap: FakeMap;
    let mapDisplay: MapDisplay;
    let stateManager: StateManager;

    beforeEach(() => {
        fakeMap = new FakeMap();
        mapDisplay = {
            getMap: () => fakeMap,
            resize: vi.fn()
        } as unknown as MapDisplay;
        stateManager = new StateManager();
    });

    function polygonSetDataCalls(): number {
        return fakeMap.sources.get('shapes-polygons')?.setData.mock.calls.length ?? 0;
    }

    it('renders a shape added after initialize via its subscription', () => {
        const renderer = new ShapeRenderer(mapDisplay, stateManager);
        renderer.initialize();

        stateManager.addShape(makePolygon('AREA1'));

        expect(polygonSetDataCalls()).toBe(1);
        const fc = fakeMap.sources.get('shapes-polygons')!.setData.mock.calls[0][0];
        expect(fc.features).toHaveLength(1);
        expect(fc.features[0].properties.name).toBe('AREA1');
    });

    it('does not stack duplicate subscriptions across style changes', () => {
        const renderer = new ShapeRenderer(mapDisplay, stateManager);
        renderer.initialize();

        renderer.onStyleChange();
        renderer.onStyleChange();

        fakeMap.sources.get('shapes-polygons')!.setData.mockClear();
        stateManager.addShape(makePolygon('AREA1'));

        // One shape update -> exactly one render, no matter how many style
        // changes happened before it.
        expect(polygonSetDataCalls()).toBe(1);
    });

    it('runs one update per displayOptions change after style changes', () => {
        const renderer = new ShapeRenderer(mapDisplay, stateManager);
        renderer.initialize();
        stateManager.addShape(makePolygon('AREA1'));

        renderer.onStyleChange();
        fakeMap.sources.get('shapes-polygons')!.setData.mockClear();

        stateManager.updateState('displayOptions', {
            ...stateManager.getDisplayOptions(),
            shapeFillColor: '#00ff00'
        });

        // updateDisplayOptions re-renders existing shapes once.
        expect(polygonSetDataCalls()).toBe(1);
    });

    it('stops rendering after destroy()', () => {
        const renderer = new ShapeRenderer(mapDisplay, stateManager);
        renderer.initialize();
        renderer.destroy();

        stateManager.addShape(makePolygon('AREA1'));

        expect(polygonSetDataCalls()).toBe(0);
    });

    it('recovers when a style change wiped the sources before onStyleChange ran', () => {
        const renderer = new ShapeRenderer(mapDisplay, stateManager);
        renderer.initialize();

        // Shape update arrives between the style wipe and onStyleChange().
        fakeMap.wipeStyle();
        stateManager.addShape(makePolygon('AREA1'));

        expect(polygonSetDataCalls()).toBe(1);
        const fc = fakeMap.sources.get('shapes-polygons')!.setData.mock.calls[0][0];
        expect(fc.features[0].properties.name).toBe('AREA1');
    });
});
