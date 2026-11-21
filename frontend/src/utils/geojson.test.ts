/**
 * Tests for the shared GeoJSON feature builders.
 */
import { describe, it, expect } from 'vitest';
import {
    pointFeature,
    lineStringFeature,
    polygonFeature,
    featureCollection,
    toLngLatCoords,
    unwrapLngLatPath,
} from './geojson';

describe('pointFeature', () => {
    it('builds a Point feature with properties', () => {
        expect(pointFeature([4.8, 52.3], { name: 'AMS' })).toEqual({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [4.8, 52.3] },
            properties: { name: 'AMS' },
        });
    });

    it('defaults properties to an empty object', () => {
        expect(pointFeature([0, 0]).properties).toEqual({});
    });

    it('sets a feature-level id only when provided', () => {
        expect(pointFeature([0, 0], {}, 'AC1').id).toBe('AC1');
        expect('id' in pointFeature([0, 0])).toBe(false);
    });
});

describe('lineStringFeature', () => {
    it('builds a LineString feature from coordinates', () => {
        const feature = lineStringFeature([[4, 52], [5, 53]], { kind: 'leg' });
        expect(feature.geometry).toEqual({
            type: 'LineString',
            coordinates: [[4, 52], [5, 53]],
        });
        expect(feature.properties).toEqual({ kind: 'leg' });
    });
});

describe('polygonFeature', () => {
    it('closes an open ring automatically', () => {
        const feature = polygonFeature([[0, 0], [1, 0], [1, 1]]);
        expect(feature.geometry.coordinates).toEqual([
            [[0, 0], [1, 0], [1, 1], [0, 0]],
        ]);
    });

    it('leaves an already-closed ring untouched', () => {
        const ring: Array<[number, number]> = [[0, 0], [1, 0], [1, 1], [0, 0]];
        expect(polygonFeature(ring).geometry.coordinates).toEqual([ring]);
    });

    it('handles an empty ring without throwing', () => {
        expect(polygonFeature([]).geometry.coordinates).toEqual([[]]);
    });
});

describe('featureCollection', () => {
    it('wraps features and defaults to empty', () => {
        const point = pointFeature([0, 0]);
        expect(featureCollection([point])).toEqual({
            type: 'FeatureCollection',
            features: [point],
        });
        expect(featureCollection()).toEqual({ type: 'FeatureCollection', features: [] });
    });
});

describe('toLngLatCoords', () => {
    it('converts {lat, lng} points to [lng, lat] pairs', () => {
        expect(toLngLatCoords([{ lat: 52, lng: 4 }, { lat: 53, lng: 5 }]))
            .toEqual([[4, 52], [5, 53]]);
    });
});

describe('unwrapLngLatPath', () => {
    it('leaves a path that never crosses ±180 unchanged in value', () => {
        expect(unwrapLngLatPath([[4, 52], [5, 53], [-6, 54]]))
            .toEqual([[4, 52], [5, 53], [-6, 54]]);
    });

    it('unwraps a segment crossing the antimeridian eastwards', () => {
        expect(unwrapLngLatPath([[179.5, 5], [-179.5, 5]]))
            .toEqual([[179.5, 5], [180.5, 5]]);
    });

    it('unwraps a segment crossing the antimeridian westwards', () => {
        expect(unwrapLngLatPath([[-179.5, 5], [179.5, 5]]))
            .toEqual([[-179.5, 5], [-180.5, 5]]);
    });

    it('unwraps cumulatively so a ring across ±180 stays closed', () => {
        expect(unwrapLngLatPath([[175, 5], [-175, 5], [-175, -5], [175, -5], [175, 5]]))
            .toEqual([[175, 5], [185, 5], [185, -5], [175, -5], [175, 5]]);
    });

    it('wraps an out-of-range first longitude into [-180, 180]', () => {
        expect(unwrapLngLatPath([[185, 5], [190, 6]]))
            .toEqual([[-175, 5], [-170, 6]]);
    });

    it('handles an empty path', () => {
        expect(unwrapLngLatPath([])).toEqual([]);
    });
});
