/**
 * Tests for EntityRenderer sprite sizing.
 *
 * The rendered icon size must be linear in the icon-size setting and
 * independent of devicePixelRatio: the sprite canvas has a fixed resolution,
 * its addImage pixelRatio scales it down to exactly SPRITE_CSS_SIZE, and the
 * layer's icon-size property is the single size control. (Previously the
 * canvas grew with the setting too, so the displayed size was quadratic in
 * the slider value and shrank on high-DPI screens.)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { AircraftData, DisplayOptions } from '../../data/types';
import { EntityRenderer, SPRITE_CANVAS_PX, SPRITE_CSS_SIZE } from './EntityRenderer';

class FakeContext {
    fillStyle = '';
    strokeStyle = '';
    lineWidth = 0;
    clearRect = vi.fn();
    beginPath = vi.fn();
    moveTo = vi.fn();
    lineTo = vi.fn();
    closePath = vi.fn();
    fill = vi.fn();
    stroke = vi.fn();
    getImageData = vi.fn((_x: number, _y: number, w: number, h: number) => ({ width: w, height: h }));
}

function fakeCanvas() {
    return {
        width: 0,
        height: 0,
        getContext: () => new FakeContext(),
    } as unknown as HTMLCanvasElement;
}

interface AddedImage {
    name: string;
    image: { width: number; height: number };
    options: { pixelRatio: number };
}

function fakeMap() {
    const images = new Map<string, AddedImage>();
    const layoutCalls: Array<[string, string, unknown]> = [];
    return {
        images,
        layoutCalls,
        hasImage: (name: string) => images.has(name),
        addImage: (name: string, image: AddedImage['image'], options: AddedImage['options']) =>
            images.set(name, { name, image, options }),
        removeImage: (name: string) => images.delete(name),
        getSource: () => undefined,
        addSource: vi.fn(),
        getLayer: (id: string) => (id.endsWith('-points') ? { id } : undefined),
        addLayer: vi.fn(),
        moveLayer: vi.fn(),
        setLayoutProperty: (layer: string, prop: string, value: unknown) =>
            layoutCalls.push([layer, prop, value]),
        setPaintProperty: vi.fn(),
    };
}

class TestRenderer extends EntityRenderer<AircraftData> {
    protected buildEntityLabel(): string {
        return '';
    }
    protected shouldShowLabels(): boolean {
        return false;
    }
    protected shouldShowEntities(): boolean {
        return true;
    }
    protected shouldShowProtectedZones(): boolean {
        return false;
    }
}

function makeRenderer(map: ReturnType<typeof fakeMap>, iconSize: number) {
    return new TestRenderer(map as unknown as MapLibreMap, {} as DisplayOptions, {
        entityType: 'Test',
        layerPrefix: 'test',
        spritePrefix: 'test',
        colors: { normal: '#fff', selected: '#0f0', conflict: '#f00', label: '#fff' },
        iconSize,
        shapeDrawer: () => undefined,
    });
}

beforeEach(() => {
    vi.stubGlobal('document', { createElement: fakeCanvas });
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('EntityRenderer sprite sizing', () => {
    it.each([0.6, 0.8, 1.4])(
        'renders sprites at the same CSS size regardless of iconSize %f',
        (iconSize) => {
            const map = fakeMap();
            makeRenderer(map, iconSize)['createSprites']();

            const sprite = map.images.get('test-normal');
            expect(sprite).toBeDefined();
            expect(sprite!.image.width).toBe(SPRITE_CANVAS_PX);
            expect(sprite!.image.width / sprite!.options.pixelRatio).toBeCloseTo(SPRITE_CSS_SIZE);
        }
    );

    it('creates normal, selected and conflict sprites', () => {
        const map = fakeMap();
        makeRenderer(map, 0.8)['createSprites']();
        expect([...map.images.keys()].sort()).toEqual(['test-conflict', 'test-normal', 'test-selected']);
    });

    it('updateIconSize only adjusts the layer icon-size property', () => {
        const map = fakeMap();
        const renderer = makeRenderer(map, 0.8);
        renderer['createSprites']();
        const spriteBefore = map.images.get('test-normal');

        renderer.updateIconSize(1.4);

        expect(map.layoutCalls).toContainEqual(['test-points', 'icon-size', 1.4]);
        // No sprite regeneration: displayed size is linear via icon-size alone
        expect(map.images.get('test-normal')).toBe(spriteBefore);
    });
});
